import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import {
  asCommand,
  ERROR_TEXT,
  NexusApi,
  OBSTRUCTION_CODES,
  POSITION_LOST_CODES,
  type NexusCommand,
  type NexusStatus,
} from './nexusApi.js';
import type { Nexus21Platform } from './platform.js';
import type { LiftConfig } from './types.js';

const TICK_MS = 250;
/** Status replies this soon after a command may predate it. */
const COMMAND_GRACE_MS = 2_000;
/** Pause between the "stop" and "go" halves of a direction change. */
const REVERSE_DELAY_MS = 600;
const SUPPORT_MSG = 'Call Nexus 21 Product Support 480-306-5462';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One Nexus 21 lift as a HomeKit Window Covering.
 * 0 = TV hidden, 100 = TV fully visible, for pop-up and drop-down lifts alike.
 *
 * IPLIN API has no STOP: any command other than the one currently running stops
 * the motion, so we stop with UP (or DOWN when moving UP), and change direction
 * by sending the new command twice.
 */
export class LiftAccessory {
  private readonly cover: Service;
  private readonly api: NexusApi;
  private readonly travelMs: number;
  private readonly idlePollMs: number;
  private readonly movingPollMs: number;
  private readonly extendCmd: NexusCommand;
  private readonly retractCmd: NexusCommand;
  private readonly presetSwitches = new Map<number, Service>();

  private current: number; // float while moving
  private target: number;
  private state: number;
  private online?: boolean;
  private failures = 0;
  private vertical?: string;
  private lastMotion?: NexusCommand;
  private graceUntil = 0;
  private activeErrors = new Set<number>();
  private closed = false;

  private motionTarget?: number;
  private lastTick = 0;

  private pollTimer?: NodeJS.Timeout;
  private motionTimer?: NodeJS.Timeout;
  private stopTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: Nexus21Platform,
    private readonly accessory: PlatformAccessory,
    private readonly cfg: LiftConfig,
  ) {
    const { Service, Characteristic } = platform;
    const dropdown = cfg.orientation === 'dropdown';

    this.extendCmd = dropdown ? 'DOWN' : 'UP';
    this.retractCmd = dropdown ? 'UP' : 'DOWN';
    this.travelMs = Math.max(1, cfg.travelTimeSeconds ?? 20) * 1000;
    this.idlePollMs = Math.max(2, cfg.pollIntervalSeconds ?? 10) * 1000;
    this.movingPollMs = Math.max(250, cfg.movingPollIntervalMs ?? 1000);
    this.current = typeof accessory.context.position === 'number' ? accessory.context.position : 0;
    this.target = this.current;
    this.state = Characteristic.PositionState.STOPPED;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Nexus 21')
      .setCharacteristic(Characteristic.Model, cfg.model ?? (dropdown ? 'Drop-down TV Lift' : 'Pop-up TV Lift'))
      .setCharacteristic(Characteristic.SerialNumber, cfg.host);

    this.cover = accessory.getService(Service.WindowCovering)
      ?? accessory.addService(Service.WindowCovering, cfg.name);

    this.cover.getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => Math.round(this.current));
    this.cover.getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.target)
      .onSet((value) => this.setTarget(value));
    this.cover.getCharacteristic(Characteristic.PositionState)
      .onGet(() => this.state);
    this.cover.getCharacteristic(Characteristic.HoldPosition)
      .onSet(async (value) => {
        if (value) {
          await this.stop();
        }
      });
    this.cover.getCharacteristic(Characteristic.ObstructionDetected)
      .onGet(() => this.isObstructed(this.activeErrors));

    this.api = new NexusApi({
      name: cfg.name,
      host: cfg.host,
      port: cfg.port ?? 80,
      timeoutMs: cfg.requestTimeoutMs ?? 4000,
      websocketUrl: cfg.websocketUrl,
      debug: cfg.debug ?? false,
    }, platform.log);
    this.api.on('status', (s: NexusStatus) => {
      this.setOnline(true);
      this.applyStatus(s);
    });
    this.api.startWebSocket();

    this.setupPresets();
    this.schedulePoll(0);
  }

  shutdown(): void {
    this.closed = true;
    clearTimeout(this.pollTimer);
    this.clearMotionTimers();
    this.api.close();
  }

  // ── HomeKit → lift ──────────────────────────────────────────────────

  private async setTarget(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    this.assertOnline();

    let target = Number(value);
    if (!this.cfg.partialPositioning && target > 0 && target < 100) {
      target = target >= 50 ? 100 : 0;
      setImmediate(() => this.cover.updateCharacteristic(Characteristic.TargetPosition, target));
    }

    if (Math.round(this.current) === target) {
      if (this.state !== Characteristic.PositionState.STOPPED) {
        await this.stop();
      }
      return;
    }

    const extending = target > this.current;
    const partial = target > 0 && target < 100;
    const stopAfter = partial ? (Math.abs(target - this.current) / 100) * this.travelMs : undefined;
    await this.startMotion(extending ? this.extendCmd : this.retractCmd, target, stopAfter);
  }

  private async startMotion(cmd: NexusCommand, target?: number, stopAfterMs?: number): Promise<void> {
    const PS = this.platform.Characteristic.PositionState;
    const moving = this.state !== PS.STOPPED;
    this.clearMotionTimers();

    try {
      if (!(moving && this.lastMotion === cmd)) {
        if (moving) {
          // A different command stops the current motion; only then send it again to go.
          const s = await this.api.status();
          if (s.vertical === 'MOVING') {
            await this.send(cmd);
            await sleep(REVERSE_DELAY_MS);
          }
        }
        await this.send(cmd);
      }
    } catch (err) {
      this.platform.log.error(`[${this.cfg.name}] ${cmd} failed: ${(err as Error).message}`);
      this.settle(Math.round(this.current));
      const { hap } = this.platform.api;
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.lastMotion = cmd;
    this.beginTracking(cmd, target ?? Math.round(this.current));
    if (stopAfterMs !== undefined) {
      this.stopTimer = setTimeout(() => void this.stop(true), stopAfterMs);
    }
  }

  /**
   * @param midTravel our own timed move, known to be in progress → skip the status
   *   check to stop as precisely as possible. Otherwise confirm MOVING first, since a
   *   "stop" sent to an idle lift would start a new move.
   */
  private async stop(midTravel = false): Promise<void> {
    this.advanceEstimate();
    this.clearMotionTimers();
    try {
      let motion = this.lastMotion;
      let moving = midTravel && motion !== undefined;
      if (!moving) {
        const s = await this.api.status();
        moving = s.vertical === 'MOVING';
        motion ??= asCommand(s.extCmd);
      }
      if (moving) {
        await this.send(motion === 'UP' ? 'DOWN' : 'UP');
      }
    } catch (err) {
      this.platform.log.error(`[${this.cfg.name}] stop failed: ${(err as Error).message}`);
    }
    this.settle(Math.round(this.current));
    this.schedulePoll(1_500);
  }

  private async send(cmd: NexusCommand): Promise<void> {
    this.graceUntil = Date.now() + COMMAND_GRACE_MS;
    const res = await this.api.command(cmd);
    if (!res.ok) {
      const detail = res.errors.map((c) => `${c} ${ERROR_TEXT[c] ?? ''}`.trim()).join(', ');
      throw new Error(`module returned ERROR${detail ? ` (${detail})` : ''}`);
    }
  }

  private assertOnline(): void {
    if (!this.online) {
      const { hap } = this.platform.api;
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ── Lift → HomeKit ──────────────────────────────────────────────────

  private schedulePoll(delayMs?: number): void {
    clearTimeout(this.pollTimer);
    if (this.closed) {
      return;
    }
    const PS = this.platform.Characteristic.PositionState;
    const idle = this.api.isWebSocketOpen ? 60_000 : this.idlePollMs;
    const delay = delayMs ?? (this.state !== PS.STOPPED ? this.movingPollMs : idle);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    try {
      const s = await this.api.status();
      this.failures = 0;
      this.setOnline(true);
      this.applyStatus(s);
    } catch (err) {
      this.failures++;
      if (this.failures >= this.offlineAfterFailures()) {
        this.setOnline(false, err as Error);
      } else {
        this.platform.log.debug(
          `[${this.cfg.name}] status poll failed (${this.failures}): ${(err as Error).message}`);
      }
    } finally {
      this.schedulePoll();
    }
  }

  /**
   * How many consecutive failed polls before HomeKit is told "No Response".
   *
   * Observed on the real module (2026-09-15): it can stop answering HTTP for
   * ~17 s in the middle of a travel, then come back and report the correct rest
   * position. Cause unconfirmed — module or Wi-Fi — but one dropped poll must
   * not settle a move that is still physically running, so while we believe the
   * lift is moving we tolerate failures for longer than a full travel.
   */
  private offlineAfterFailures(): number {
    const moving = this.state !== this.platform.Characteristic.PositionState.STOPPED;
    return moving ? Math.max(5, Math.ceil((this.travelMs * 1.5) / this.movingPollMs)) : 3;
  }

  private applyStatus(s: NexusStatus): void {
    const PS = this.platform.Characteristic.PositionState;
    this.handleErrors(s.errors);

    const prev = this.vertical;
    const v = s.vertical;
    this.vertical = v;
    if (v !== prev) {
      this.refreshPresetSwitches();
    }
    if (!v) {
      return;
    }

    const inGrace = Date.now() < this.graceUntil;
    const rest = this.restPosition(v);

    if (rest !== undefined) {
      // Ignore a pre-command reading that contradicts where we're heading.
      if (inGrace && this.state !== PS.STOPPED && rest !== this.target) {
        return;
      }
      if (this.state !== PS.STOPPED || this.target !== rest || Math.round(this.current) !== rest) {
        this.settle(rest);
      }
      return;
    }

    if (v === 'MOVING' && !inGrace && this.state === PS.STOPPED && prev !== undefined && prev !== 'MOVING') {
      this.onExternalMotion(s.extCmd, prev);
    } else if (v !== 'MOVING') {
      this.platform.log.debug(`[${this.cfg.name}] unhandled VERTICAL value "${v}"`);
    }
  }

  /** Motion started by the RF remote / keypad (not by us). */
  private onExternalMotion(extCmd: string | undefined, prev: string): void {
    let cmd = asCommand(extCmd);
    let target: number | undefined;

    if (cmd === this.extendCmd) {
      target = 100;
    } else if (cmd === this.retractCmd) {
      target = 0;
    } else if (cmd) {
      target = this.presetPosition(Number(cmd.slice(3)));
    } else if (prev === this.retractCmd) {
      cmd = this.extendCmd;
      target = 100;
    } else if (prev === this.extendCmd) {
      cmd = this.retractCmd;
      target = 0;
    }

    this.platform.log.info(`[${this.cfg.name}] external motion detected (${extCmd ?? 'unknown source'})`);
    this.lastMotion = cmd;
    this.clearMotionTimers();
    this.beginTracking(cmd, target ?? Math.round(this.current));
  }

  private beginTracking(cmd: NexusCommand | undefined, target: number): void {
    const { Characteristic } = this.platform;
    const PS = Characteristic.PositionState;
    const extending = target > this.current || (target === Math.round(this.current) && cmd === this.extendCmd);

    this.target = target;
    this.cover.updateCharacteristic(Characteristic.TargetPosition, target);
    this.setState(extending ? PS.INCREASING : PS.DECREASING);
    this.animate(target);
    this.schedulePoll(this.movingPollMs);
  }

  /** Time-based position estimate; the module only reports UP/DOWN/MOVING/MEMn. */
  private animate(target: number): void {
    const { Characteristic } = this.platform;
    const startedAt = Date.now();
    this.motionTarget = target;
    this.lastTick = startedAt;

    this.motionTimer = setInterval(() => {
      this.advanceEstimate();
      this.cover.updateCharacteristic(Characteristic.CurrentPosition, Math.round(this.current));

      // Normally the status poll settles us. Failsafe if it never confirms.
      if (this.current === target && Date.now() - startedAt > this.travelMs * 1.5) {
        this.settle(target);
      }
    }, TICK_MS);
  }

  private advanceEstimate(): void {
    const target = this.motionTarget;
    if (target === undefined) {
      return;
    }
    const now = Date.now();
    const step = ((now - this.lastTick) / this.travelMs) * 100;
    this.lastTick = now;
    this.current = target > this.current
      ? Math.min(target, this.current + step)
      : Math.max(target, this.current - step);
  }

  private settle(pos: number): void {
    const { Characteristic } = this.platform;
    this.clearMotionTimers();
    this.lastMotion = undefined;
    this.current = pos;
    this.target = pos;
    this.cover.updateCharacteristic(Characteristic.TargetPosition, pos);
    this.cover.updateCharacteristic(Characteristic.CurrentPosition, pos);
    this.setState(Characteristic.PositionState.STOPPED);

    if (this.accessory.context.position !== pos) {
      this.accessory.context.position = pos;
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
  }

  private restPosition(vertical: string): number | undefined {
    if (vertical === this.extendCmd) {
      return 100;
    }
    if (vertical === this.retractCmd) {
      return 0;
    }
    const mem = /^MEM([123])$/.exec(vertical);
    if (mem) {
      return this.presetPosition(Number(mem[1])) ?? Math.round(this.current);
    }
    return undefined;
  }

  private presetPosition(slot: number): number | undefined {
    const p = this.cfg.memoryPresets?.find((m) => Number(m.slot) === slot)?.position;
    return typeof p === 'number' ? Math.max(0, Math.min(100, Math.round(p))) : undefined;
  }

  private setState(state: number): void {
    if (this.state !== state) {
      this.state = state;
      this.cover.updateCharacteristic(this.platform.Characteristic.PositionState, state);
    }
  }

  private setOnline(online: boolean, err?: Error): void {
    if (online === this.online) {
      return;
    }
    const wasKnown = this.online !== undefined;
    this.online = online;
    if (online) {
      this.failures = 0;
      this.platform.log.info(`[${this.cfg.name}] IP module reachable at ${this.cfg.host}`);
    } else {
      this.platform.log.warn(`[${this.cfg.name}] IP module unreachable: ${err?.message ?? 'unknown error'}`);
      if (wasKnown && this.state !== this.platform.Characteristic.PositionState.STOPPED) {
        this.settle(Math.round(this.current));
      }
    }
  }

  private handleErrors(codes: number[]): void {
    const { log, Characteristic } = this.platform;
    const next = new Set(codes);
    const name = this.cfg.name;

    for (const code of next) {
      if (this.activeErrors.has(code)) {
        continue;
      }
      const text = ERROR_TEXT[code] ?? 'Unknown error';
      if (POSITION_LOST_CODES.has(code)) {
        log.error(`[${name}] error ${code}: ${text}. ${SUPPORT_MSG}`);
      } else {
        log.warn(`[${name}] error ${code}: ${text}`);
      }
    }
    for (const code of this.activeErrors) {
      if (!next.has(code)) {
        log.info(`[${name}] error ${code} cleared`);
      }
    }

    const wasObstructed = this.isObstructed(this.activeErrors);
    this.activeErrors = next;
    const obstructed = this.isObstructed(next);
    if (obstructed !== wasObstructed) {
      this.cover.updateCharacteristic(Characteristic.ObstructionDetected, obstructed);
    }
  }

  private isObstructed(codes: Set<number>): boolean {
    return [...codes].some((c) => OBSTRUCTION_CODES.has(c));
  }

  private clearMotionTimers(): void {
    clearInterval(this.motionTimer);
    clearTimeout(this.stopTimer);
    this.motionTarget = undefined;
    this.motionTimer = undefined;
    this.stopTimer = undefined;
  }

  // ── Memory presets: switch is ON while the lift sits at that memory ──

  private setupPresets(): void {
    const { Service, Characteristic } = this.platform;
    const presets = (this.cfg.memoryPresets ?? []).filter((p) => [1, 2, 3].includes(Number(p.slot)));
    const wanted = new Set(presets.map((p) => `mem-${p.slot}`));

    for (const svc of [...this.accessory.services]) {
      if (svc.UUID === Service.Switch.UUID && svc.subtype && !wanted.has(svc.subtype)) {
        this.accessory.removeService(svc);
      }
    }

    for (const preset of presets) {
      const slot = Number(preset.slot);
      const subtype = `mem-${slot}`;
      const sw = this.accessory.getServiceById(Service.Switch, subtype)
        ?? this.accessory.addService(Service.Switch, preset.name, subtype);

      if (!sw.testCharacteristic(Characteristic.ConfiguredName)) {
        sw.addCharacteristic(Characteristic.ConfiguredName);
      }
      sw.updateCharacteristic(Characteristic.ConfiguredName, preset.name);

      sw.getCharacteristic(Characteristic.On)
        .onGet(() => this.vertical === `MEM${slot}`)
        .onSet(async (value) => {
          if (!value) {
            // "Off" has no meaning for a memory position; reflect the real state again.
            setTimeout(() => this.refreshPresetSwitches(), 300);
            return;
          }
          this.assertOnline();
          if (this.vertical !== `MEM${slot}`) {
            await this.startMotion(`MEM${slot}` as NexusCommand, this.presetPosition(slot));
          }
        });

      this.presetSwitches.set(slot, sw);
    }
  }

  private refreshPresetSwitches(): void {
    const { Characteristic } = this.platform;
    for (const [slot, sw] of this.presetSwitches) {
      sw.updateCharacteristic(Characteristic.On, this.vertical === `MEM${slot}`);
    }
  }
}

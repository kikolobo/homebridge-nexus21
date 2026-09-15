import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { Logging } from 'homebridge';
import WebSocket from 'ws';

/** Commands accepted by POST /api/command (IPLIN API v1.0). */
export type NexusCommand = 'UP' | 'DOWN' | 'MEM1' | 'MEM2' | 'MEM3';
const COMMANDS: readonly string[] = ['UP', 'DOWN', 'MEM1', 'MEM2', 'MEM3'];

export const asCommand = (value?: string): NexusCommand | undefined =>
  value && COMMANDS.includes(value) ? (value as NexusCommand) : undefined;

export interface NexusStatus {
  ok: boolean;
  /** UP | DOWN | MOVING | MEM1..3 */
  vertical?: string;
  /** LEFT | CENTER | RIGHT | MOVING | NA | MEM1..3 (2-actuator systems only) */
  horizontal?: string;
  /** Last command seen on the LIN bus that didn't come from the API (RF remote, keypad…) */
  extCmd?: string;
  errors: number[];
}

export const ERROR_TEXT: Record<number, string> = {
  8: 'Unexpected reset',
  9: 'LIN bus error',
  10: 'Power fail',
  11: 'Channel count changed',
  12: 'Position difference exceeded',
  13: 'Short circuit while running',
  14: 'Position checksum failed (all channels lost position)',
  15: 'Power limit reached',
  16: 'Illegal key combination',
  17: 'Safety function blocked movement',
  18: 'Missing initialization plug',
  19: 'LIN power dropped',
  23: 'Channel 1 actuator missing',
  24: 'Channel 2 actuator missing',
  29: 'Channel 1 actuator type changed',
  30: 'Channel 2 actuator type changed',
  35: 'Channel 1 pulse errors',
  36: 'Channel 2 pulse errors',
  41: 'Channel 1 overload (up)',
  42: 'Channel 2 overload (up)',
  47: 'Channel 1 overload (down)',
  48: 'Channel 2 overload (down)',
  53: 'Channel 1 anti-collision triggered',
  54: 'Channel 2 anti-collision triggered',
  59: 'Channel 1 SLS input activated',
  60: 'Channel 2 SLS input activated',
  65: 'Channel 1B type changed',
  66: 'Channel 2B type changed',
  71: 'Channel 1A output shorted',
  72: 'Channel 1B output shorted',
  73: 'Channel 2A output shorted',
  74: 'Channel 2B output shorted',
  84: 'DC unit disconnected or failed',
  85: 'Radio restarted',
  86: 'Connection to master lost',
  87: 'Connection to slave 1 lost',
  500: 'REST API argument error',
  501: 'IP module lost communication with the control box',
  502: 'Reference 1 position lost',
  503: 'Reference 2 position lost',
  504: 'IP module EEPROM failure',
};

export const POSITION_LOST_CODES = new Set([14, 502, 503]);
export const OBSTRUCTION_CODES = new Set([41, 42, 47, 48, 53, 54]);

function parseErrors(description: unknown): number[] {
  if (description === undefined || description === null || description === '') {
    return [];
  }
  const items = Array.isArray(description) ? description : [description];
  return items
    .map((item) => JSON.stringify(item)?.match(/\d+/)?.[0])
    .filter((m): m is string => m !== undefined)
    .map(Number);
}

/** Tolerates key casing differences between firmware builds. */
export function normalizeStatus(body: unknown): NexusStatus {
  const obj: Record<string, unknown> = {};
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) {
      obj[k.toUpperCase()] = v;
    }
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : undefined);
  return {
    ok: str(obj.STATUS) !== 'ERROR',
    vertical: str(obj.VERTICAL),
    horizontal: str(obj.HORIZONTAL),
    extCmd: str(obj.EXTCMD),
    errors: parseErrors(obj.DESCRIPTION),
  };
}

export interface NexusApiOptions {
  name: string;
  host: string;
  port: number;
  timeoutMs: number;
  websocketUrl?: string;
  debug: boolean;
}

/**
 * REST client for the Nexus 21 IP module, plus optional websocket feedback.
 * Emits 'status' (NexusStatus) for websocket pushes.
 */
export class NexusApi extends EventEmitter {
  private ws?: WebSocket;
  private wsOpen = false;
  private wsBackoffMs = 1_000;
  private wsFailures = 0;
  private wsReconnectTimer?: NodeJS.Timeout;
  private wsPingTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(
    private readonly opts: NexusApiOptions,
    private readonly log: Logging,
  ) {
    super();
  }

  get isWebSocketOpen(): boolean {
    return this.wsOpen;
  }

  status(): Promise<NexusStatus> {
    return this.request('GET', '/api/status');
  }

  command(command: NexusCommand): Promise<NexusStatus> {
    return this.request('POST', '/api/command', { COMMAND: command });
  }

  private async request(method: 'GET' | 'POST', path: string, body?: object): Promise<NexusStatus> {
    const { host, port, timeoutMs, name, debug } = this.opts;
    const url = `http://${host}${port === 80 ? '' : `:${port}`}${path}`;
    const payload = body ? JSON.stringify(body) : undefined;
    if (debug && payload) {
      this.log.info(`[${name}] ${method} ${path} ${payload}`);
    }

    const res = await fetch(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (debug && (method === 'POST' || text !== this.lastStatusText)) {
      this.log.info(`[${name}] ${method} ${path} → ${res.status} ${text}`);
    }
    if (method === 'GET') {
      this.lastStatusText = text;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status}, non-JSON response: ${text.slice(0, 120)}`);
    }
    return normalizeStatus(json);
  }

  private lastStatusText?: string;

  // ── Websocket feedback (optional) ─────────────────────────────────

  startWebSocket(): void {
    const url = this.opts.websocketUrl;
    if (!url || this.closing || this.ws) {
      return;
    }
    const { name } = this.opts;
    const ws = new WebSocket(url, { handshakeTimeout: 5_000 });
    this.ws = ws;
    let alive = true;

    ws.on('open', () => {
      this.wsOpen = true;
      this.wsBackoffMs = 1_000;
      this.wsFailures = 0;
      this.log.info(`[${name}] websocket connected (${url})`);
      this.wsPingTimer = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 30_000);
    });
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', (data) => {
      alive = true;
      const text = data.toString();
      if (this.opts.debug) {
        this.log.info(`[${name}] ws ← ${text}`);
      }
      try {
        this.emit('status', normalizeStatus(JSON.parse(text)));
      } catch {
        this.log.debug(`[${name}] ignoring non-JSON websocket message`);
      }
    });
    ws.on('error', (err) => {
      const msg = `[${name}] websocket error: ${err.message}`;
      if (this.wsFailures++ === 0) {
        this.log.warn(`${msg} — falling back to polling, will keep retrying`);
      } else {
        this.log.debug(msg);
      }
    });
    ws.on('close', () => {
      if (this.wsOpen) {
        this.log.warn(`[${name}] websocket closed`);
      }
      this.wsOpen = false;
      this.ws = undefined;
      clearInterval(this.wsPingTimer);
      if (!this.closing) {
        const delay = this.wsBackoffMs;
        this.wsBackoffMs = Math.min(this.wsBackoffMs * 2, 60_000);
        this.wsReconnectTimer = setTimeout(() => this.startWebSocket(), delay);
      }
    });
  }

  close(): void {
    this.closing = true;
    clearTimeout(this.wsReconnectTimer);
    clearInterval(this.wsPingTimer);
    this.ws?.terminate();
  }
}

export interface DiscoveredModule {
  address: string;
  server?: string;
}

/** SSDP M-SEARCH exactly as the API sheet specifies (field order matters on old firmware). */
export function discoverModules(timeoutMs = 3_000): Promise<DiscoveredModule[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredModule>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const message = Buffer.from([
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 1',
      'ST: urn:Nexus21:service:basicevent:1',
      '',
      '',
    ].join('\r\n'));

    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };

    socket.on('message', (buf, rinfo) => {
      const text = buf.toString();
      if (!/nexus21/i.test(text)) {
        return;
      }
      const server = /^SERVER:\s*(.+)$/im.exec(text)?.[1]?.trim();
      found.set(rinfo.address, { address: rinfo.address, server });
    });
    socket.on('error', finish);
    socket.bind(0, () => {
      const send = () => socket.send(message, 1900, '239.255.255.250', () => undefined);
      send();
      setTimeout(send, 500);
      setTimeout(finish, timeoutMs);
    });
  });
}

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { LiftAccessory } from './liftAccessory.js';
import { discoverModules } from './nexusApi.js';
import { DEFAULT_HOST, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { LiftConfig } from './types.js';

export class Nexus21Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly lifts: LiftAccessory[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    api.on('didFinishLaunching', () => {
      this.setupLifts();
      if (this.config.discover !== false) {
        void this.logDiscovery();
      }
    });
    api.on('shutdown', () => this.lifts.forEach((l) => l.shutdown()));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private setupLifts(): void {
    const configs = this.liftConfigs();
    const active = new Set<string>();

    for (const cfg of configs) {

      const uuid = this.api.hap.uuid.generate(`nexus21:${cfg.host}:${cfg.name}`);
      active.add(uuid);

      let accessory = this.cached.get(uuid);
      if (accessory) {
        accessory.context.config = cfg;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info(`Adding lift: ${cfg.name} (${cfg.host})`);
        accessory = new this.api.platformAccessory(cfg.name, uuid);
        accessory.context.config = cfg;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.lifts.push(new LiftAccessory(this, accessory, cfg));
    }

    const stale = [...this.cached.values()].filter((a) => !active.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessory(ies)`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  /** Lifts from config; host falls back to DEFAULT_HOST, and an empty list gets one default lift. */
  private liftConfigs(): LiftConfig[] {
    const raw = (this.config.lifts ?? []) as Partial<LiftConfig>[];
    const list = raw.length > 0 ? raw : [{ name: 'TV Lift' }];
    return list.map((l, i) => ({
      ...l,
      name: l.name?.trim() || `TV Lift${i > 0 ? ` ${i + 1}` : ''}`,
      host: l.host?.trim() || DEFAULT_HOST,
    }));
  }

  private async logDiscovery(): Promise<void> {
    const modules = await discoverModules();
    const configured = new Map(this.liftConfigs().map((l) => [l.host, l.name]));
    if (modules.length === 0) {
      this.log.debug('SSDP: no Nexus 21 IP modules answered');
      return;
    }
    for (const m of modules) {
      const name = configured.get(m.address);
      const info = m.server ? ` (${m.server})` : '';
      this.log.info(name
        ? `SSDP: found ${m.address}${info} → "${name}"`
        : `SSDP: found unconfigured Nexus 21 IP module at ${m.address}${info}`);
    }
  }
}

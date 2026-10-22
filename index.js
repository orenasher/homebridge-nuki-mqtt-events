'use strict';
const mqtt = require('mqtt');

const PLUGIN = 'homebridge-nuki-mqtt-events';
const PLATFORM = 'NukiMqttEvents';

// Nuki MQTT API v1.6 – lockActionEvent: LockAction,Trigger,AuthID,CodeID,Extra
// Extra for keypad actions = keypad source (0 back key, 1 code, 2 fingerprint)
const SOURCES = { backkey: 0, code: 1, fingerprint: 2 };
const ACTIONS = { unlock: 1, lock: 2, unlatch: 3, locknGo: 4, locknGoUnlatch: 5 };

module.exports = (api) => api.registerPlatform(PLUGIN, PLATFORM, NukiMqttEvents);

class NukiMqttEvents {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();
    this.switches = [];
    if (!this.config.deviceId) {
      log.error('Missing "deviceId" (e.g. 4E2CC127). Plugin disabled.');
      return;
    }
    api.on('didFinishLaunching', () => { this.setup(); this.connect(); });
    api.on('shutdown', () => this.client && this.client.end(true));
  }

  configureAccessory(acc) { this.cached.set(acc.UUID, acc); }

  setup() {
    const { Service, Characteristic, uuid } = this.api.hap;
    const defs = this.config.switches && this.config.switches.length
      ? this.config.switches
      : [{ name: 'Nuki Fingerprint', sources: ['fingerprint'] }];
    const keep = new Set();

    for (const def of defs) {
      const id = uuid.generate(`${PLATFORM}:${this.config.deviceId}:${def.name}`);
      keep.add(id);
      let acc = this.cached.get(id);
      if (!acc) {
        acc = new this.api.platformAccessory(def.name, id);
        this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [acc]);
      }
      acc.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Oren Asher')
        .setCharacteristic(Characteristic.Model, 'Nuki MQTT Event Switch')
        .setCharacteristic(Characteristic.SerialNumber, `${this.config.deviceId}-${def.name}`);
      const svc = acc.getService(Service.Switch) || acc.addService(Service.Switch, def.name);
      const sw = {
        def,
        svc,
        on: false,
        timer: null,
        sources: (def.sources || ['fingerprint']).map((s) => SOURCES[s]).filter((s) => s !== undefined),
        actions: (def.actions || ['unlock', 'unlatch', 'locknGoUnlatch']).map((a) => ACTIONS[a]).filter(Boolean),
        codeIds: (def.codeIds || []).map(Number),
      };
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => sw.on)
        .onSet((v) => { if (v) this.pulse(sw, 'manual'); else this.set(sw, false); });
      this.switches.push(sw);
    }

    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, stale);
  }

  connect() {
    const c = this.config;
    const url = `mqtt://${c.host || '127.0.0.1'}:${c.port || 1883}`;
    const topic = `${c.topicPrefix || 'nuki'}/${c.deviceId}/lockActionEvent`;
    this.client = mqtt.connect(url, {
      username: c.username || undefined,
      password: c.password || undefined,
      clientId: `hb-nuki-events-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 5000,
    });
    this.client.on('connect', () => {
      this.log.info(`Connected to ${url}, listening on ${topic}`);
      this.client.subscribe(topic, { qos: 0 });
    });
    this.client.on('error', (e) => this.log.warn('MQTT error:', e.message));
    this.client.on('message', (_t, buf, packet) => {
      if (packet.retain) return; // ignore old retained events after reconnect
      this.handle(buf.toString().trim());
    });
  }

  handle(payload) {
    const p = payload.split(',').map((x) => Number(x));
    const [action, trigger, authId, codeId, extra] = p;
    if (this.config.logEvents !== false) {
      this.log.info(`Event "${payload}" → action=${action} trigger=${trigger} authId=${authId} codeId=${codeId} extra=${extra}`);
    }
    // Keypad actions (code / fingerprint) carry a non-zero code ID
    const fromKeypad = codeId > 0;
    if (!fromKeypad) return;
    for (const sw of this.switches) {
      if (!sw.actions.includes(action)) continue;
      if (!sw.sources.includes(extra)) continue;
      if (sw.codeIds.length && !sw.codeIds.includes(codeId)) continue;
      this.pulse(sw, payload);
    }
  }

  pulse(sw, why) {
    this.log.info(`"${sw.def.name}" triggered (${why})`);
    clearTimeout(sw.timer);
    this.set(sw, true);
    sw.timer = setTimeout(() => this.set(sw, false), Number(this.config.resetMs) || 1000);
  }

  set(sw, v) {
    sw.on = v;
    sw.svc.updateCharacteristic(this.api.hap.Characteristic.On, v);
  }
}

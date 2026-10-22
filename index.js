'use strict';
const { MiniBroker, topicMatches } = require('./broker');

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
    this.mode = this.config.brokerMode || (this.config.host ? 'external' : 'embedded');
    this.deviceKey = this.config.deviceId || 'nuki';
    api.on('didFinishLaunching', () => {
      this.setup();
      if (this.mode === 'embedded') this.startBroker(); else this.connect();
    });
    api.on('shutdown', () => {
      if (this.client) this.client.end(true);
      if (this.broker) this.broker.close();
    });
  }

  configureAccessory(acc) { this.cached.set(acc.UUID, acc); }

  setup() {
    const { Service, Characteristic, uuid } = this.api.hap;
    const defs = this.config.switches && this.config.switches.length
      ? this.config.switches
      : [{ name: 'Nuki Fingerprint', sources: ['fingerprint'] }];
    const keep = new Set();

    for (const def of defs) {
      const id = uuid.generate(`${PLATFORM}:${this.deviceKey}:${def.name}`);
      keep.add(id);
      let acc = this.cached.get(id);
      if (!acc) {
        acc = new this.api.platformAccessory(def.name, id);
        this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [acc]);
      }
      acc.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'Oren Asher')
        .setCharacteristic(Characteristic.Model, 'Nuki MQTT Event Switch')
        .setCharacteristic(Characteristic.SerialNumber, `${this.deviceKey}-${def.name}`);
      const svc = acc.getService(Service.Switch) || acc.addService(Service.Switch, def.name);
      const sw = {
        def,
        svc,
        on: false,
        timer: null,
        sources: (def.sources || ['fingerprint']).map((s) => SOURCES[s]).filter((s) => s !== undefined),
        actions: (def.actions || ['unlock', 'unlatch', 'locknGoUnlatch']).map((a) => ACTIONS[a]).filter(Boolean),
        codeIds: (def.codeIds || []).filter((x) => x !== null && x !== '' && Number(x) > 0).map(Number),
      };
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => sw.on)
        .onSet((v) => { if (v) this.pulse(sw, 'manual'); else this.set(sw, false); });
      this.switches.push(sw);
    }

    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, stale);
  }

  eventTopic() {
    return `${this.config.topicPrefix || 'nuki'}/${this.config.deviceId || '+'}/lockActionEvent`;
  }

  async startBroker() {
    const c = this.config;
    const port = Number(c.brokerPort) || 1883;
    const filter = this.eventTopic();
    this.broker = new MiniBroker({ username: c.username, password: c.password });
    const fs = require('fs');
    const store = require('path').join(this.api.user.storagePath(), 'nuki-mqtt-events-retained.json');
    try {
      const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
      for (const [t, b64] of Object.entries(saved)) this.broker.retained.set(t, Buffer.from(b64, 'base64'));
    } catch (e) { /* first run */ }
    let saveTimer = null;
    this.broker.on('retainChanged', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const out = {};
        for (const [t, b] of this.broker.retained) out[t] = b.toString('base64');
        fs.writeFile(store, JSON.stringify(out), () => {});
      }, 2000);
    });
    this.broker.on('warn', (m) => this.log.warn(`Broker: ${m}`));
    this.broker.on('clientConnected', (cl) => this.log.info(`Broker: client "${cl.id}" connected from ${cl.socket.remoteAddress}`));
    this.broker.on('clientDisconnected', (cl) => this.log.info(`Broker: client "${cl.id}" disconnected`));
    this.broker.on('message', (topic, payload) => {
      if (topicMatches(filter, topic)) this.handle(payload.toString().trim());
    });
    try {
      await this.broker.listen(port, '0.0.0.0');
      this.log.info(`Built-in MQTT broker listening on port ${port}${c.username ? ' (login required)' : ' (no login)'} — waiting for ${filter}`);
    } catch (e) {
      this.log.error(`Could not start the built-in MQTT broker on port ${port}: ${e.message}. Is another MQTT broker already using this port?`);
    }
  }

  connect() {
    const mqtt = require('mqtt');
    const c = this.config;
    const url = `mqtt://${c.host || '127.0.0.1'}:${c.port || 1883}`;
    const topic = this.eventTopic();
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

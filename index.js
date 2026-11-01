'use strict';
const { MiniBroker, topicMatches } = require('./broker');

const PLUGIN = 'homebridge-nuki-mqtt-events';
const PLATFORM = 'NukiMqttEvents';

// Nuki MQTT API v1.6 – lockActionEvent: LockAction,Trigger,AuthID,CodeID,Extra
// Extra for keypad actions = keypad source (0 back key, 1 code, 2 fingerprint)
const SOURCES = { backkey: 0, code: 1, fingerprint: 2 };
const ACTIONS = { unlock: 1, lock: 2, unlatch: 3, locknGo: 4, locknGoUnlatch: 5 };

// Nuki MQTT "state" → Matter LockState (0 not fully locked, 1 locked, 2 unlocked).
// Transitional states (2 unlocking, 4 locking, 7 unlatching) are ignored.
const NUKI_TO_MATTER = { 1: 1, 3: 2, 5: 2, 6: 2, 254: 0 };
const NUKI_STATE_NAMES = { 0: 'uncalibrated', 1: 'locked', 2: 'unlocking', 3: 'unlocked', 4: 'locking', 5: 'unlatched', 6: "unlocked (lock 'n' go)", 7: 'unlatching', 253: 'boot run', 254: 'motor blocked', 255: 'undefined' };
const UNLOCKED_STATES = [3, 5, 6];

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
    this.prefix = this.config.topicPrefix || 'nuki';
    this.nukiId = this.config.deviceId || null; // learned from incoming topics when not configured
    this.nukiState = null;
    this.stateWaiters = new Set();
    this.lockCfg = this.config.doorLock && this.config.doorLock.enabled ? this.config.doorLock : null;
    if (this.config.childLock && this.config.childLock.style === 'matter') this.config.childLock.style = 'lock'; // removed experiment
    this.keypadCfg = this.config.keypad && this.config.keypad.enabled ? this.config.keypad : null;
    this.keypadLow = false;
    this.childCfg = this.config.childLock && this.config.childLock.enabled && this.config.childLock.token ? this.config.childLock : null;
    this.childOn = false;
    this.doorOpen = null;
    this.relockTimer = null;
    this.matter = null;
    this.battery = { percent: null, charging: null, critical: false };
    api.on('didFinishLaunching', () => {
      this.setup();
      if (this.mode === 'embedded') this.startBroker(); else this.connect();
      if (this.lockCfg) this.startLock();
      if (this.childCfg) this.startChildLock();
    });
    api.on('shutdown', () => {
      clearTimeout(this.relockTimer);
      clearInterval(this.childPoll);
      if (this.client) this.client.end(true);
      if (this.broker) this.broker.close();
      if (this.matter) this.matter.close().catch(() => {});
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

    if (this.lockCfg) keep.add(this.setupDoorSwitch());
    if (this.keypadCfg) keep.add(this.setupKeypad());
    if (this.childCfg) keep.add(this.setupChildLock());

    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, stale);
  }

  // ---------- Keypad accessory: a button (fingerprint = single press, code = double press) + battery ----------
  // The Nuki only reports keypadBatteryCritical (true/false) — no percentage — so the level shows 100% or 10%.

  setupKeypad() {
    const { Service, Characteristic, uuid } = this.api.hap;
    const name = this.keypadCfg.name || 'Nuki Keypad';
    const id = uuid.generate(`${PLATFORM}:${this.deviceKey}:keypad`);
    let acc = this.cached.get(id);
    if (!acc) {
      acc = new this.api.platformAccessory(name, id);
      this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [acc]);
    }
    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Nuki')
      .setCharacteristic(Characteristic.Model, 'Keypad')
      .setCharacteristic(Characteristic.SerialNumber, `${this.deviceKey}-keypad`);
    const btn = acc.getService(Service.StatelessProgrammableSwitch) || acc.addService(Service.StatelessProgrammableSwitch, name);
    btn.getCharacteristic(Characteristic.ProgrammableSwitchEvent).setProps({ validValues: [0, 1] });
    const bat = acc.getService(Service.Battery) || acc.addService(Service.Battery, `${name} Battery`);
    this.keypadLow = acc.context.low === true;
    bat.getCharacteristic(Characteristic.BatteryLevel).onGet(() => (this.keypadLow ? 10 : 100));
    bat.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => (this.keypadLow ? 1 : 0));
    bat.getCharacteristic(Characteristic.ChargingState).onGet(() => 2); // not chargeable
    this.keypadAcc = acc;
    this.keypadBtn = btn;
    this.keypadBat = bat;
    return id;
  }

  onKeypadBattery(raw) {
    const low = ['true', '1'].includes(String(raw).trim().toLowerCase());
    if (low === this.keypadLow && this.keypadAcc && this.keypadAcc.context.low !== undefined) return;
    this.keypadLow = low;
    if (!this.keypadAcc) return;
    this.keypadAcc.context.low = low;
    const C = this.api.hap.Characteristic;
    this.keypadBat.updateCharacteristic(C.StatusLowBattery, low ? 1 : 0);
    this.keypadBat.updateCharacteristic(C.BatteryLevel, low ? 10 : 100);
    this.log.info(`Keypad battery: ${low ? 'LOW — replace the batteries' : 'OK'}`);
  }

  keypadPress(source) {
    if (!this.keypadBtn) return;
    const ev = source === SOURCES.fingerprint ? 0 : source === SOURCES.code ? 1 : null;
    if (ev === null) return;
    this.keypadBtn.updateCharacteristic(this.api.hap.Characteristic.ProgrammableSwitchEvent, ev);
  }

  // ---------- Child lock: disables the button on the Smart Lock (Nuki Web API, cloud) ----------

  setupChildLock() {
    const { Service, Characteristic, uuid } = this.api.hap;
    const name = this.childCfg.name || 'Child Lock';
    const id = uuid.generate(`${PLATFORM}:${this.deviceKey}:${this.childCfg.style === 'lock' ? 'hap-lock' : 'child-lock'}`);
    let acc = this.cached.get(id);
    if (!acc) {
      acc = new this.api.platformAccessory(name, id);
      this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [acc]);
    }
    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Nuki')
      .setCharacteristic(Characteristic.Model, 'Child Lock (button disabled)')
      .setCharacteristic(Characteristic.SerialNumber, `${this.deviceKey}-child-lock`);
    this.childOn = acc.context.childOn === true;
    if (this.childCfg.style === 'lock') return this.setupHapLock(acc, id);
    const svc = acc.getService(Service.Switch) || acc.addService(Service.Switch, name);
    svc.getCharacteristic(Characteristic.On)
      .onGet(() => this.childOn)
      .onSet((v) => this.applyChild(!!v));
    this.childAcc = acc;
    this.childSvc = svc;
    return id;
  }

  async applyChild(on) {
    this.log.info(`Child lock ${on ? 'ON — disabling' : 'OFF — enabling'} the button on the Smart Lock`);
    try {
      await this.nukiWeb.setButtonEnabled(!on);
      this.childPendingUntil = Date.now() + 20 * 60000; // the lock reports the new value only after it syncs
      this.setChild(on);
    } catch (e) {
      this.log.error(`Child lock: ${e.message}`);
      throw new this.api.hap.HapStatusError(-70402);
    }
  }

  // HomeKit lock with the child lock inside it (LockPhysicalControls), plus battery and jammed state.
  setupHapLock(acc, id) {
    const { Service, Characteristic } = this.api.hap;
    const name = this.childCfg.lockName || 'Nuki';
    acc.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, 'Smart Lock (MQTT)');
    const lock = acc.getService(Service.LockMechanism) || acc.addService(Service.LockMechanism, name);
    lock.getCharacteristic(Characteristic.LockCurrentState).onGet(() => this.hapCurrent());
    lock.getCharacteristic(Characteristic.LockTargetState)
      .onGet(() => (this.nukiState === 1 ? 1 : UNLOCKED_STATES.includes(this.nukiState) ? 0 : this.hapTarget ?? 1))
      .onSet(async (v) => {
        const action = Number(v) === 1 ? 'lock' : 'unlock';
        if (action === 'lock' && this.doorOpen === true) {
          this.log.warn('HomeKit lock: refused to lock while the door is open');
          throw new this.api.hap.HapStatusError(-70402);
        }
        this.hapTarget = Number(v);
        this.actuate(action, 'Home (HomeKit lock)').catch((e) => this.log.warn(`HomeKit lock: ${e.message}`));
      });
    // the child lock lives on the Lock Management service below (Home ignored it here)
    if (lock.testCharacteristic(Characteristic.LockPhysicalControls)) lock.removeCharacteristic(lock.getCharacteristic(Characteristic.LockPhysicalControls));
    // Lock Management service (part of Apple's HomeKit lock profile): auto-lock timeout + child lock
    const mgmt = acc.getService(Service.LockManagement) || acc.addService(Service.LockManagement, `${name} Settings`);
    mgmt.getCharacteristic(Characteristic.Version).onGet(() => '1.0');
    mgmt.getCharacteristic(Characteristic.LockControlPoint).onSet(() => {});
    const addChar = (svc, C) => (svc.testCharacteristic(C) ? svc.getCharacteristic(C) : svc.addCharacteristic(C));
    this.hapAutoLock = Number(acc.context.autoLock ?? (this.lockCfg && this.lockCfg.lockAfterCloseSeconds) ?? 0) || 0;
    addChar(mgmt, Characteristic.AutoSecurityTimeout)
      .onGet(() => this.hapAutoLock)
      .onSet((v) => {
        this.hapAutoLock = Number(v) || 0;
        acc.context.autoLock = this.hapAutoLock;
        this.log.info(`HomeKit lock: Home set auto-lock to ${this.hapAutoLock ? `${this.hapAutoLock} s` : 'off'}`);
      });
    addChar(mgmt, Characteristic.LockPhysicalControls)
      .onGet(() => (this.childOn ? 1 : 0))
      .onSet((v) => this.applyChild(Number(v) === 1));
    this.hapMgmt = mgmt;
    const bat = acc.getService(Service.Battery) || acc.addService(Service.Battery, `${name} Battery`);
    bat.getCharacteristic(Characteristic.BatteryLevel).onGet(() => this.battery.percent ?? 100);
    bat.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => (this.battery.critical || (this.battery.percent ?? 100) <= 20 ? 1 : 0));
    bat.getCharacteristic(Characteristic.ChargingState).onGet(() => (this.battery.charging ? 1 : 0));
    this.childAcc = acc;
    this.hapLock = lock;
    this.hapBat = bat;
    return id;
  }

  hapCurrent() {
    const s = this.nukiState;
    if (s === 1) return 1; // secured
    if (UNLOCKED_STATES.includes(s)) return 0; // unsecured
    if (s === 254) return 2; // jammed
    return 3; // unknown
  }

  updateHapLock() {
    if (!this.hapLock) return;
    const C = this.api.hap.Characteristic;
    const cur = this.hapCurrent();
    this.hapLock.updateCharacteristic(C.LockCurrentState, cur);
    if (cur === 0 || cur === 1) { this.hapTarget = cur; this.hapLock.updateCharacteristic(C.LockTargetState, cur); }
  }

  updateHapBattery() {
    if (!this.hapBat) return;
    const C = this.api.hap.Characteristic, b = this.battery;
    if (b.percent != null) this.hapBat.updateCharacteristic(C.BatteryLevel, b.percent);
    this.hapBat.updateCharacteristic(C.StatusLowBattery, b.critical || (b.percent ?? 100) <= 20 ? 1 : 0);
    this.hapBat.updateCharacteristic(C.ChargingState, b.charging ? 1 : 0);
  }

  setChild(on) {
    this.childOn = on;
    if (this.childAcc) this.childAcc.context.childOn = on;
    if (this.childSvc) this.childSvc.updateCharacteristic(this.api.hap.Characteristic.On, on);
    if (this.hapMgmt) this.hapMgmt.updateCharacteristic(this.api.hap.Characteristic.LockPhysicalControls, on ? 1 : 0);
  }

  startChildLock() {
    const { NukiWeb } = require('./nukiWeb');
    this.nukiWeb = new NukiWeb(this.childCfg.token, this.config.deviceId || this.nukiId, this.childCfg.smartlockId);
    // Nuki Web keeps the setting it was given; read it back so changes made in the Nuki app show up too.
    const poll = async () => {
      try {
        if (!this.nukiWeb.nukiIdHex && this.nukiId) this.nukiWeb.nukiIdHex = this.nukiId.toLowerCase();
        const lock = await this.nukiWeb.get();
        const on = lock.config && lock.config.buttonEnabled === false;
        if (on === this.childOn) { this.childPendingUntil = 0; return; }
        if (Date.now() < (this.childPendingUntil || 0)) return; // our change is still on its way to the lock
        { this.log.info(`Child lock is ${on ? 'ON' : 'OFF'} (from Nuki Web)`); this.setChild(on); }
      } catch (e) {
        this.log.warn(`Child lock: ${e.message}`);
      }
    };
    setTimeout(poll, 5000);
    this.childPoll = setInterval(poll, (Number(this.childCfg.pollMinutes) || 10) * 60000);
  }

  // ---------- Door state input (fed by a Home automation from any door sensor, e.g. Aqara) ----------

  setupDoorSwitch() {
    const { Service, Characteristic, uuid } = this.api.hap;
    const name = this.lockCfg.doorSwitchName || 'Door Open';
    const id = uuid.generate(`${PLATFORM}:${this.deviceKey}:door-switch`);
    let acc = this.cached.get(id);
    if (!acc) {
      acc = new this.api.platformAccessory(name, id);
      this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [acc]);
    }
    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Oren Asher')
      .setCharacteristic(Characteristic.Model, 'Door State Input')
      .setCharacteristic(Characteristic.SerialNumber, `${this.deviceKey}-door`);
    const svc = acc.getService(Service.Switch) || acc.addService(Service.Switch, name);
    this.doorAcc = acc;
    this.doorSvc = svc;
    this.doorOpen = typeof acc.context.doorOpen === 'boolean' ? acc.context.doorOpen : false;
    svc.getCharacteristic(Characteristic.On)
      .onGet(() => this.doorOpen === true)
      .onSet((v) => this.setDoor(!!v, 'Home automation'));
    return id;
  }

  setDoor(open, why) {
    const changed = open !== this.doorOpen;
    this.doorOpen = open;
    if (this.doorAcc) this.doorAcc.context.doorOpen = open;
    if (!changed) return;
    this.log.info(`Door ${open ? 'opened' : 'closed'} (${why})`);
    if (this.matter) this.matter.setDoorOpen(open).catch((e) => this.log.warn(`Matter lock: could not update door state: ${e.message}`));
    if (open) {
      if (this.relockTimer) this.log.info('Door opened — auto-lock paused until it closes');
      clearTimeout(this.relockTimer);
      this.relockTimer = null;
    } else {
      this.armRelock('door closed');
    }
  }

  // Auto-lock: the timer starts when the lock is unlocked (by any means — app, keypad, fingerprint, Home)
  // and restarts whenever the door closes. It never locks while the door is open.
  // Delay = the auto-lock time set in the Home app (Matter autoRelockTime), otherwise the plugin setting.
  relockDelay() {
    const fromHome = this.matter ? this.matter.autoRelockTime() : 0;
    if (fromHome > 0) return fromHome;
    if (this.hapAutoLock > 0) return this.hapAutoLock; // set in Home on the HomeKit lock
    const own = this.lockCfg && this.lockCfg.lockAfterCloseSeconds;
    if (own !== undefined && own !== null && own !== '' && Number(own) >= 0) return Number(own);
    return null;
  }

  armRelock(why) {
    clearTimeout(this.relockTimer);
    this.relockTimer = null;
    if (!(this.lockCfg || this.hapLock) || !UNLOCKED_STATES.includes(this.nukiState)) return;
    if (this.doorOpen === true) { this.log.info(`Unlocked (${why}) — will auto-lock after the door closes`); return; }
    const delay = this.relockDelay();
    if (delay === null) return;
    this.log.info(`Auto-lock in ${delay} s (${why})`);
    this.relockTimer = setTimeout(() => {
      this.relockTimer = null;
      if (this.doorOpen === true || !UNLOCKED_STATES.includes(this.nukiState)) return;
      this.actuate('lock', 'auto-lock').catch((e) => this.log.warn(`Auto-lock failed: ${e.message}`));
    }, delay * 1000);
  }

  // ---------- Matter lock ----------

  async startLock() {
    const c = this.lockCfg;
    const path = require('path');
    try {
      const { startMatterLock } = require('./matterLock');
      this.matter = await startMatterLock({
        log: this.log,
        actuate: (a, why) => this.actuate(a, why),
        isDoorOpen: () => this.doorOpen,
      }, {
        storagePath: path.join(this.api.user.storagePath(), 'nuki-matter-lock'),
        port: Number(c.matterPort) || 5560,
        passcode: Number(c.passcode) || 20262027,
        discriminator: Number(c.discriminator) || 3127,
        name: c.name || 'Front Door',
        serial: String(this.config.deviceId || 'nuki-lock'),
        lockState: this.nukiState !== null ? NUKI_TO_MATTER[this.nukiState] : undefined,
        doorOpen: this.doorOpen,
        battery: this.battery,
        matterLogLevel: c.matterLogLevel,
      });
      if (this.nukiState !== null) this.pushLockState();
    } catch (e) {
      this.log.error(`Matter lock could not start: ${e.stack || e.message}`);
    }
  }

  pushLockState() {
    this.updateHapLock();
    const s = NUKI_TO_MATTER[this.nukiState];
    if (s === undefined || !this.matter) return;
    if (this.nukiState === 254) {
      this.matter.reportJam().catch((e) => this.log.warn(`Matter lock: could not report jam: ${e.message}`));
      return;
    }
    this.matter.setLockState(s).catch((e) => this.log.warn(`Matter lock: could not update lock state: ${e.message}`));
  }

  // Send a lock action to the Nuki and wait until it reports the target state.
  actuate(action, why) {
    if (!this.nukiId) return Promise.reject(new Error('Nuki device ID not known yet (no MQTT message received from the lock)'));
    const done = action === 'lock' ? (s) => s === 1 : (s) => UNLOCKED_STATES.includes(s);
    if (done(this.nukiState)) return Promise.resolve();
    const code = action === 'lock' ? ACTIONS.lock : ACTIONS.unlock;
    const topic = `${this.prefix}/${this.nukiId}/lockAction`;
    this.log.info(`${action === 'lock' ? 'Locking' : 'Unlocking'} Nuki (${why}) → ${topic} = ${code}`);
    const op = { action, at: Date.now() };
    if (why === 'Home (Matter)' || why === 'Matter auto-relock') this.matterOp = op; else this.pluginOp = op;
    this.publish(topic, String(code));
    const timeoutMs = (Number(this.lockCfg && this.lockCfg.actionTimeout) || 30) * 1000;
    return new Promise((resolve, reject) => {
      const w = {
        check: (s) => {
          if (done(s)) { clearTimeout(w.timer); this.stateWaiters.delete(w); resolve(); return; }
          if (s === 254) { clearTimeout(w.timer); this.stateWaiters.delete(w); reject(new Error('Nuki motor blocked')); }
        },
      };
      w.timer = setTimeout(() => {
        this.stateWaiters.delete(w);
        reject(new Error(`Nuki did not report ${action === 'lock' ? 'locked' : 'unlocked'} within ${timeoutMs / 1000} s — is "lock actions" allowed in the Nuki MQTT settings?`));
      }, timeoutMs);
      this.stateWaiters.add(w);
    });
  }

  onNukiState(raw) {
    const s = Number(raw);
    if (!Number.isFinite(s) || s === this.nukiState) return;
    const wasUnlocked = UNLOCKED_STATES.includes(this.nukiState);
    this.nukiState = s;
    if (s === 254) this.log.warn('Nuki state: MOTOR BLOCKED — the lock is jammed');
    else this.log.info(`Nuki state: ${NUKI_STATE_NAMES[s] || s}`);
    for (const w of [...this.stateWaiters]) w.check(s);
    this.pushLockState();
    const nowLocked = s === 1, nowUnlocked = UNLOCKED_STATES.includes(s);
    if ((nowLocked && this.prevSettled === 3) || (nowUnlocked && this.prevSettled === 1)) this.reportOperation(nowLocked ? 'lock' : 'unlock');
    if (nowLocked || nowUnlocked) this.prevSettled = s === 1 ? 1 : 3;
    if (s === 1) { clearTimeout(this.relockTimer); this.relockTimer = null; }
    if (UNLOCKED_STATES.includes(s) && !wasUnlocked) this.armRelock('unlocked');
  }

  // Lock/unlock that did not come through Matter (Nuki app, keypad, fingerprint, button, plugin auto-lock):
  // send a Matter LockOperation event so Home shows "locked/unlocked" notifications, like a native lock.
  reportOperation(action) {
    if (!this.matter) return;
    const fresh = (op) => op && op.action === action && Date.now() - op.at < 60000;
    if (fresh(this.matterOp)) { this.matterOp = null; return; } // Home command — matter.js already reported it
    const byPlugin = fresh(this.pluginOp);
    this.pluginOp = null;
    clearTimeout(this.opTimer);
    this.opTimer = setTimeout(() => {
      const ev = this.lastEvent && Date.now() - this.lastEvent.at < 15000 ? this.lastEvent : null;
      let source = 1; // Manual
      if (byPlugin) source = 4; // Auto (plugin auto-lock)
      else if (ev && ev.codeId > 0) source = 3; // Keypad (code / fingerprint)
      else if (ev && ev.trigger === 2) source = 5; // Button on the lock
      else if (ev && (ev.trigger === 3 || ev.trigger === 6)) source = 4; // Auto (Nuki timer / auto lock)
      else if (ev && ev.trigger === 0) source = 2; // Nuki app (Bluetooth)
      this.lastEvent = null;
      this.matter.reportOperation(action, source).catch((e) => this.log.warn(`Matter lock: could not report ${action}: ${e.message}`));
    }, 1500);
  }

  // ---------- MQTT ----------

  eventTopic() {
    return `${this.prefix}/${this.config.deviceId || '+'}/lockActionEvent`;
  }

  stateTopic() {
    return `${this.prefix}/${this.config.deviceId || '+'}/state`;
  }

  batteryTopic() {
    return `${this.prefix}/${this.config.deviceId || '+'}/+`;
  }

  // Nuki MQTT: batteryChargeState (0-100), batteryCharging (true/false), batteryCritical (true/false)
  onBattery(field, raw) {
    const b = this.battery;
    const v = String(raw).trim().toLowerCase();
    const before = JSON.stringify(b);
    if (field === 'batteryChargeState') { const n = Number(v); if (Number.isFinite(n)) b.percent = Math.max(0, Math.min(100, n)); }
    else if (field === 'batteryCharging') b.charging = v === 'true' || v === '1';
    else if (field === 'batteryCritical') b.critical = v === 'true' || v === '1';
    else return;
    if (JSON.stringify(b) === before) return;
    this.log.info(`Nuki battery: ${b.percent ?? '?'}%${b.charging ? ', charging' : ''}${b.critical ? ', CRITICAL' : ''}`);
    this.updateHapBattery();
    if (this.matter) this.matter.setBattery(b).catch((e) => this.log.warn(`Matter lock: could not update battery: ${e.message}`));
  }

  learnId(topic) {
    if (this.nukiId) return;
    const parts = topic.split('/');
    if (parts.length >= 3 && parts[0] === this.prefix) {
      this.nukiId = parts[1];
      this.log.info(`Nuki device ID: ${this.nukiId}`);
    }
  }

  onMqtt(topic, payload, retained) {
    if (topic.endsWith('/keypadBatteryCritical') && topicMatches(this.batteryTopic(), topic)) {
      this.onKeypadBattery(payload);
    } else if (topicMatches(this.eventTopic(), topic)) {
      this.learnId(topic);
      if (!retained) this.handle(payload);
    } else if (topicMatches(this.stateTopic(), topic)) {
      this.learnId(topic);
      this.onNukiState(payload);
    } else if ((this.lockCfg || this.hapLock) && topicMatches(this.batteryTopic(), topic)) {
      this.onBattery(topic.split('/').pop(), payload);
    }
  }

  publish(topic, payload) {
    if (this.broker) this.broker.publish(topic, Buffer.from(payload), false, null);
    else if (this.client) this.client.publish(topic, payload, { qos: 1 });
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
    // Last known lock state from before the restart
    for (const [t, b] of this.broker.retained) {
      if (t.endsWith('/keypadBatteryCritical') && topicMatches(this.batteryTopic(), t)) this.onKeypadBattery(b.toString());
      else if (topicMatches(this.stateTopic(), t)) { this.learnId(t); this.onNukiState(b.toString().trim()); }
      else if ((this.lockCfg || this.hapLock) && topicMatches(this.batteryTopic(), t)) this.onBattery(t.split('/').pop(), b.toString());
    }
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
    this.broker.on('message', (topic, payload, from) => {
      if (from === null) return; // our own publishes
      this.onMqtt(topic, payload.toString().trim(), false);
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
    const topics = [this.eventTopic()];
    if (this.lockCfg || this.hapLock) topics.push(this.stateTopic(), this.batteryTopic());
    else if (this.keypadCfg) topics.push(`${this.prefix}/${this.config.deviceId || '+'}/keypadBatteryCritical`);
    this.client = mqtt.connect(url, {
      username: c.username || undefined,
      password: c.password || undefined,
      clientId: `hb-nuki-events-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 5000,
    });
    this.client.on('connect', () => {
      this.log.info(`Connected to ${url}, listening on ${topics.join(', ')}`);
      this.client.subscribe(topics, { qos: 0 });
    });
    this.client.on('error', (e) => this.log.warn('MQTT error:', e.message));
    this.client.on('message', (topic, buf, packet) => {
      this.onMqtt(topic, buf.toString().trim(), !!packet.retain);
    });
  }

  handle(payload) {
    const p = payload.split(',').map((x) => Number(x));
    const [action, trigger, authId, codeId, extra] = p;
    this.lastEvent = { action, trigger, codeId, at: Date.now() };
    if (this.config.logEvents !== false) {
      this.log.info(`Event "${payload}" → action=${action} trigger=${trigger} authId=${authId} codeId=${codeId} extra=${extra}`);
    }
    // Keypad actions (code / fingerprint) carry a non-zero code ID
    const fromKeypad = codeId > 0;
    if (!fromKeypad) return;
    this.keypadPress(extra);
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

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



// Matter schedules → Nuki authorization limits (the keypad holds one day mask, one time window, one date range)
const NUKI_DAY = { sunday: 1, monday: 64, tuesday: 32, wednesday: 16, thursday: 8, friday: 4, saturday: 2 };
const MATTER_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function nukiLimits(sched) {
  const out = { allowedWeekDays: 127, allowedFromTime: 0, allowedUntilTime: 0, allowedFromDate: null, allowedUntilDate: null };
  if (!sched) return out;
  const week = sched.week || [];
  if (week.length) {
    let mask = 0, from = 24 * 60, until = 0;
    for (const w of week) {
      const dm = w.daysMask;
      MATTER_DAYS.forEach((d, i) => { if (typeof dm === 'number' ? dm & (1 << i) : dm && dm[d]) mask |= NUKI_DAY[d]; });
      from = Math.min(from, w.startHour * 60 + w.startMinute);
      until = Math.max(until, w.endHour * 60 + w.endMinute);
    }
    out.allowedWeekDays = mask || 127;
    if (!(from === 0 && until >= 23 * 60 + 59)) { out.allowedFromTime = from; out.allowedUntilTime = until; }
  }
  const year = sched.year || [];
  if (year.length) {
    const local = (t) => { const d = new Date((t + 946684800) * 1000); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()).toISOString(); };
    out.allowedFromDate = local(Math.min(...year.map((y) => y.localStartTime)));
    out.allowedUntilDate = local(Math.max(...year.map((y) => y.localEndTime)));
  }
  return out;
}

const FINGERPRINT_SWITCH = { name: 'Nuki Fingerprint', sources: ['fingerprint'], actions: ['unlock', 'unlatch', 'locknGoUnlatch'] };

// Ready-made setups ("Quick setup" in the settings). A config without a preset keeps working as before (custom).
function applyPreset(cfg, log) {
  const preset = cfg.preset || 'custom';
  if (preset === 'custom') return cfg;
  const c = JSON.parse(JSON.stringify(cfg));
  const token = c.childLock && c.childLock.token;
  const lock = preset === 'full' || preset === 'lock';
  c.doorLock = { ...(c.doorLock || {}), enabled: lock };
  if (lock) c.doorLock.accessCodes = !!token && c.doorLock.accessCodes !== false;
  c.keypad = { ...(c.keypad || {}), enabled: preset === 'full' };
  c.childLock = { ...(c.childLock || {}), enabled: lock && !!token, style: 'matter' };
  if (preset === 'lock') c.noSwitches = true; // lock only: no extra switches
  else if (!(Array.isArray(c.switches) && c.switches.length)) c.switches = [{ ...FINGERPRINT_SWITCH }];
  if (log && lock && !token) log.info('Quick setup: add a Nuki Web token in the settings to get the child lock and keypad codes from Home');
  return c;
}

class NukiMqttEvents {
  constructor(log, config, api) {
    this.log = log;
    this.config = applyPreset(config || {}, log);
    this.startedAt = Date.now();
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
      if (this.lockCfg && this.lockCfg.accessCodes !== false) this.loadCodes();
    });
    api.on('shutdown', () => {
      clearTimeout(this.relockTimer);
      clearInterval(this.childPoll);
      clearTimeout(this.codeTimer); clearTimeout(this.codeRetry); clearTimeout(this.leftTimer); clearTimeout(this.leftPulse); clearTimeout(this.statusTimer);
      if (this.client) this.client.end(true);
      if (this.broker) this.broker.close();
      if (this.matter) this.matter.close().catch(() => {});
    });
  }

  configureAccessory(acc) { this.cached.set(acc.UUID, acc); }

  setup() {
    const { Service, Characteristic, uuid } = this.api.hap;
    const defs = this.config.noSwitches ? [] : this.config.switches && this.config.switches.length
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
    if (this.lockCfg) for (const id of this.setupAlerts()) keep.add(id);
    if (this.childCfg && this.childCfg.style !== 'matter') {
      try { keep.add(this.setupChildLock()); } catch (e) { this.log.error(`Child lock setup failed: ${e.stack || e.message}`); }
    }

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

  // ---------- Door alerts: forced open, left open (repeats while open) ----------

  alertCfg() {
    const a = (this.lockCfg && this.lockCfg.alerts) || {};
    return {
      forced: a.forcedOpen !== false,
      forcedName: a.forcedName || 'Door Forced Open',
      leftMin: a.leftOpenMinutes === undefined || a.leftOpenMinutes === null || a.leftOpenMinutes === '' ? 5 : Number(a.leftOpenMinutes) || 0,
      repeatMin: a.repeat === false ? 0 : Number(a.repeatMinutes) || Number(a.leftOpenMinutes) || 5,
      leftName: a.leftOpenName || 'Door Left Open',
    };
  }

  sensorAcc(key, name, model) {
    const { Service, Characteristic, uuid } = this.api.hap;
    const id = uuid.generate(`${PLATFORM}:${this.deviceKey}:${key}`);
    let acc = this.cached.get(id);
    if (!acc) {
      acc = new this.api.platformAccessory(name, id);
      this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [acc]);
    }
    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Nuki')
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, `${this.deviceKey}-${key}`);
    const svc = acc.getService(Service.ContactSensor) || acc.addService(Service.ContactSensor, name);
    svc.getCharacteristic(Characteristic.ContactSensorState).onGet(() => (this.alertState[key] ? 1 : 0));
    this.alertSvc[key] = svc;
    return id;
  }

  setupAlerts() {
    const c = this.alertCfg(), ids = [];
    this.alertState = this.alertState || {};
    this.alertSvc = {};
    if (c.forced) ids.push(this.sensorAcc('forced-open', c.forcedName, 'Door Forced Open'));
    if (c.leftMin > 0) ids.push(this.sensorAcc('left-open', c.leftName, 'Door Left Open'));
    return ids;
  }

  setAlert(key, on) {
    this.alertState[key] = on;
    const svc = this.alertSvc && this.alertSvc[key];
    if (svc) svc.updateCharacteristic(this.api.hap.Characteristic.ContactSensorState, on ? 1 : 0);
  }

  // Remember when someone used the lock, so a door opened right after an unlock is not "forced"
  touchLock() { this.lockActivityAt = Date.now(); }

  doorAlerts(open) {
    if (!this.alertState) return;
    const c = this.alertCfg();
    clearTimeout(this.leftTimer); clearTimeout(this.leftPulse);
    if (!open) {
      if (this.alertState['forced-open']) this.log.info('Door closed — forced-open alert cleared');
      this.setAlert('forced-open', false);
      this.setAlert('left-open', false);
      return;
    }
    // Checked a few seconds later, so a lock state that arrives just after the door sensor is taken into account
    const openedAt = Date.now();
    if (c.forced) {
      setTimeout(() => {
        if (this.doorOpen !== true || this.doorOpenedAt !== openedAt) return;
        const recent = openedAt - (this.lockActivityAt || 0) < (this.forcedGraceMs ?? 15000);
        if (this.nukiState !== 1 || recent) return;
        // Only trust "locked" when the Nuki is connected and its state is current (not right after a restart)
        const settle = this.forcedSettleMs ?? 30000;
        const embedded = this.mode === 'embedded';
        const fresh = embedded
          ? this.nukiOnline === true && openedAt - (this.nukiOnlineAt || 0) > settle
          : openedAt - (this.startedAt || 0) > settle * 4;
        if (!fresh) { this.log.info('Door opened while the lock state is not current (Nuki not connected yet) — no forced-open alert'); return; }
        this.log.warn('ALERT: the door was opened while the lock is locked (forced open)');
        this.setAlert('forced-open', true);
        if (this.matter && this.matter.reportAlarm) this.matter.reportAlarm(6).catch(() => {});
      }, this.forcedCheckMs ?? 3000);
    }
    this.doorOpenedAt = openedAt;
    if (c.leftMin > 0) {
      const unit = this.alertMinuteMs ?? 60000;
      const fire = () => {
        this.log.warn(`ALERT: the door has been open for ${Math.round((Date.now() - this.doorOpenedAt) / unit)} min`);
        if (this.alertState['left-open']) { // already on: closed → open again = a new notification
          this.setAlert('left-open', false);
          this.leftPulse = setTimeout(() => this.setAlert('left-open', true), this.alertPulseMs ?? 2000);
        } else this.setAlert('left-open', true);
        if (this.matter && this.matter.reportAlarm) this.matter.reportAlarm(7).catch(() => {});
        if (c.repeatMin > 0) this.leftTimer = setTimeout(fire, c.repeatMin * unit);
      };
      this.leftTimer = setTimeout(fire, c.leftMin * unit);
    }
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

  // Home's switch is answered right away; one background worker sends only the latest wanted value to
  // Nuki Web. Quick toggles are merged, and "423 Locked" (the lock is still applying the previous change)
  // is retried with a growing delay instead of failing.
  applyChild(on) {
    this.log.info(`Child lock ${on ? 'ON — disabling' : 'OFF — enabling'} the button on the Smart Lock`);
    this.childWant = on;
    this.childPendingUntil = Date.now() + 20 * 60000; // the lock reports the new value only after it syncs
    this.setChild(on);
    if (!this.childWorker) this.childWorker = this.childSync().finally(() => { this.childWorker = null; });
    return Promise.resolve();
  }

  async childSync() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(this.childDebounceMs ?? 1500); // merge quick on/off taps
    let attempt = 0, delay = this.childRetryMs ?? 3000;
    for (;;) {
      const want = this.childWant;
      if (want === this.childSent) return; // Nuki already has this value
      try {
        await this.nukiWeb.setButtonEnabled(!want);
        this.childSent = want;
        if (attempt) this.log.info(`Child lock ${want ? 'ON' : 'OFF'} sent to Nuki Web`);
        attempt = 0; delay = this.childRetryMs ?? 3000;
      } catch (e) {
        const busy = / 423:/.test(e.message);
        if (++attempt > (busy ? 8 : 3)) {
          this.log.error(`Child lock: gave up — ${e.message}`);
          this.childPendingUntil = 0;
          if (this.childSent !== undefined) this.setChild(this.childSent);
          return;
        }
        this.log.warn(`Child lock: ${busy ? 'the Smart Lock is still applying the previous change' : e.message} — retrying in ${Math.round(delay / 1000)} s`);
        await sleep(delay);
        delay = Math.min(delay * 2, 60000);
      }
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
    // HAP-NodeJS names it LockManagementAutoSecurityTimeout
    const AutoTimeout = Characteristic.LockManagementAutoSecurityTimeout || Characteristic.AutoSecurityTimeout;
    this.hapAutoLock = Number(acc.context.autoLock ?? (this.lockCfg && this.lockCfg.lockAfterCloseSeconds) ?? 0) || 0;
    addChar(mgmt, AutoTimeout)
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
    // Child lock as a secondary lock service ("Child Lock" section with Locked / Unlocked in the accessory)
    const childName = this.childCfg.name || 'Child Lock';
    const child = acc.getServiceById(Service.LockMechanism, 'child') || acc.addService(Service.LockMechanism, childName, 'child');
    child.getCharacteristic(Characteristic.LockCurrentState).onGet(() => (this.childOn ? 1 : 0));
    child.getCharacteristic(Characteristic.LockTargetState)
      .onGet(() => (this.childOn ? 1 : 0))
      .onSet((v) => this.applyChild(Number(v) === 1));
    lock.setPrimaryService(true);
    this.hapChild = child;
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
    if (this.hapChild) {
      const C = this.api.hap.Characteristic;
      this.hapChild.updateCharacteristic(C.LockCurrentState, on ? 1 : 0);
      this.hapChild.updateCharacteristic(C.LockTargetState, on ? 1 : 0);
    }
    if (this.matter && this.matter.setChildLock) this.matter.setChildLock(on).catch(() => {});
  }

  web() {
    if (this.nukiWeb) return this.nukiWeb;
    const token = this.childCfg ? this.childCfg.token : this.config.childLock && this.config.childLock.token;
    if (!token) return null;
    const { NukiWeb } = require('./nukiWeb');
    const smartlockId = this.config.childLock && this.config.childLock.smartlockId;
    this.nukiWeb = new NukiWeb(token, this.config.deviceId || this.nukiId, smartlockId);
    return this.nukiWeb;
  }

  // ---------- Access codes (Home "Manage Access" → Nuki Keypad) ----------

  codesFile() { return require('path').join(this.api.user.storagePath(), 'nuki-matter-lock', 'keypad-codes.json'); }

  loadCodes() {
    try { this.codeMap = JSON.parse(require('fs').readFileSync(this.codesFile(), 'utf8')); } catch (e) { this.codeMap = {}; }
  }

  saveCodes() {
    this.writeStatus();
    const fs = require('fs');
    try {
      fs.mkdirSync(require('path').dirname(this.codesFile()), { recursive: true });
      fs.writeFileSync(this.codesFile(), JSON.stringify(this.codeMap, null, 2), { mode: 0o600 });
    } catch (e) { this.log.warn(`Access codes: could not save: ${e.message}`); }
  }

  // Nuki Keypad codes: 6 digits 1-9 (the keypad has no 0) and not starting with 12
  checkCode(code) {
    if (!/^[1-9]{6}$/.test(code)) return 'the Nuki Keypad needs exactly 6 digits from 1 to 9 (no 0)';
    if (code.startsWith('12')) return 'Nuki Keypad codes cannot start with 12';
    return null;
  }

  // Called by the Matter lock after Home changed users/codes: list = current PIN codes, fresh = {index: code}
  onCodes(list, fresh, userIndex) {
    if (!this.codeMap) this.loadCodes();
    for (const [i, code] of Object.entries(fresh)) {
      const cur = this.codeMap[i] || {};
      this.codeMap[i] = { ...cur, code, removed: false, synced: cur.code === code && !cur.removed ? cur.synced : false };
      if (userIndex != null) this.codeMap[i].userIndex = userIndex;
    }
    // names (and owners) of the codes; removals are reported by onCodesRemoved
    for (const c of list) {
      const e = this.codeMap[c.index];
      if (!e) continue;
      if (c.userIndex != null) e.userIndex = c.userIndex;
      if (c.name && e.homeName !== c.name) e.homeName = c.name; // a name Home gave the person
    }
    this.saveCodes();
    this.syncCodesSoon();
  }

  // A small status file for the settings page (pairing code, codes on the keypad, last message from the lock)
  writeStatus() {
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      try {
        const fs = require('fs'), path = require('path');
        const dir = path.join(this.api.user.storagePath(), 'nuki-matter-lock');
        fs.mkdirSync(dir, { recursive: true });
        const pairing = this.matter && this.matter.pairing ? this.matter.pairing() : null;
        const codes = Object.entries(this.codeMap || {}).filter(([, e]) => !e.removed)
          .map(([i, e]) => ({ index: Number(i), name: e.name || null, onKeypad: !!e.id || (e.synced && e.skipped !== e.code), keypadOk: !this.checkCode(String(e.code || '')), limited: JSON.stringify(this.limitsFor(e.userIndex)) !== JSON.stringify(this.limitsFor(null)) }));
        const status = {
          at: new Date().toISOString(), version: require('./package.json').version,
          nukiId: this.nukiId || null, lastSeen: this.lastSeen || null, nukiState: this.nukiState,
          battery: this.battery, doorOpen: this.doorOpen, matter: pairing, codes, childOn: this.childOn,
        };
        fs.writeFileSync(path.join(dir, 'ui-status.json'), JSON.stringify(status, null, 2));
      } catch (e) { /* the status file is only for the settings page */ }
    }, 1000);
  }

  limitsFile() { return require('path').join(this.api.user.storagePath(), 'nuki-matter-lock', 'keypad-limits.json'); }

  // Home set or cleared a guest schedule: the user's keypad codes get the same days / hours / dates
  onSchedule(userIndex, sched) {
    if (!this.userLimits) { try { this.userLimits = JSON.parse(require('fs').readFileSync(this.limitsFile(), 'utf8')); } catch (e) { this.userLimits = {}; } }
    const empty = !(sched.week && sched.week.length) && !(sched.year && sched.year.length);
    if (empty) delete this.userLimits[userIndex]; else this.userLimits[userIndex] = sched;
    try { require('fs').writeFileSync(this.limitsFile(), JSON.stringify(this.userLimits), { mode: 0o600 }); } catch (e) { /* folder not there yet */ }
    this.log.info(`Access codes: ${empty ? 'no time limits' : 'time limits'} for Home user ${userIndex}`);
    if (!this.codeMap) this.loadCodes();
    this.syncCodesSoon();
  }

  limitsFor(userIndex) {
    if (!this.userLimits) { try { this.userLimits = JSON.parse(require('fs').readFileSync(this.limitsFile(), 'utf8')); } catch (e) { this.userLimits = {}; } }
    return nukiLimits(userIndex != null ? this.userLimits[userIndex] : null);
  }

  // Home removed a code (by its index), every code of a user, or all codes
  onCodesRemoved(what) {
    if (!this.codeMap) this.loadCodes();
    let n = 0;
    for (const [i, e] of Object.entries(this.codeMap)) {
      if (what.all || String(what.index) === i || (what.userIndex != null && e.userIndex === what.userIndex)) { e.removed = true; n++; }
    }
    this.log.info(`Access codes: Home removed ${what.all ? 'all codes' : what.index != null ? `code ${what.index}` : `the codes of user ${what.userIndex}`}${n ? '' : ' (not on the keypad)'}`);
    if (!n) return;
    this.saveCodes();
    this.syncCodesSoon();
  }

  syncCodesSoon() {
    clearTimeout(this.codeTimer);
    this.codeTimer = setTimeout(() => {
      if (this.codeSyncing) return this.syncCodesSoon();
      this.codeSyncing = true;
      this.syncCodes().catch((e) => this.log.warn(`Access codes: ${e.message}`)).finally(() => { this.codeSyncing = false; });
    }, this.codeDelayMs ?? 3000); // Home sends the code and then the name — wait for both
  }

  // Keypad names: "Apple Home" for a single code, "Apple Home 1", "Apple Home 2"... when there are more
  // (codes that cannot go on the keypad are not counted). A name Home gives the person wins.
  nameCodes() {
    const base = (this.lockCfg && this.lockCfg.codeName) || 'Apple Home';
    const active = Object.keys(this.codeMap)
      .filter((i) => !this.codeMap[i].removed && !this.checkCode(String(this.codeMap[i].code || '')))
      .sort((a, b) => Number(a) - Number(b));
    active.forEach((i, n) => {
      const e = this.codeMap[i];
      const name = e.homeName || (active.length === 1 ? base : `${base} ${n + 1}`);
      if (e.name !== name) { if (e.name) e.oldName = e.name; e.name = name; e.synced = false; }
      const lim = JSON.stringify(this.limitsFor(e.userIndex));
      if (e.id && JSON.stringify(e.sentLimits || this.limitsFor(null)) !== lim) e.synced = false;
    });
  }

  async syncCodes() {
    const web = this.web();
    this.nameCodes();
    if (!web) { this.log.warn('Access codes: add the Nuki Web token (Child lock section) to send the codes to the Nuki Keypad'); return; }
    let retry = false;
    for (const [i, e] of Object.entries(this.codeMap)) {
      try {
        if (e.removed) {
          if (!e.id && e.code && e.skipped !== e.code) {
            const found = await web.findKeypadCode(e.code, e.name);
            if (found) e.id = found.id;
          }
          if (e.id) {
            try { await web.removeKeypadCode(e.id); } catch (err) { if (!/ 404:/.test(err.message)) throw err; } // already gone in the Nuki app
            this.log.info(`Access codes: removed "${e.name}" from the Nuki Keypad`);
          } else if (e.code && e.skipped !== e.code && e.synced) {
            this.log.warn(`Access codes: "${e.name}" was not found on Nuki Web — remove it in the Nuki app if it is still there`);
          }
          delete this.codeMap[i];
        } else if (!e.synced) {
          const name = e.name || 'Apple Home';
          const why = this.checkCode(String(e.code || ''));
          if (why) {
            // Home keeps the code (it works for Home itself); it just cannot go on the Nuki Keypad
            if (e.id) { await web.removeKeypadCode(e.id); e.id = null; e.authId = null; }
            if (e.skipped !== e.code) this.log.warn(`Access codes: "${name}" stays in Home only — ${why}`);
            e.skipped = e.code; e.synced = true; this.saveCodes();
            continue;
          }
          if (!e.id) { const f = await web.findKeypadCode(e.code); if (f) e.id = f.id; } // already there (id not known yet)
          if (e.id && !(await web.listAuths()).some((a) => a.id === e.id)) { e.id = null; e.authId = null; } // deleted in the Nuki app: create it again
          if (e.id) {
            const limits = this.limitsFor(e.userIndex);
            await web.updateKeypadCode(e.id, { name, code: e.code, ...limits });
            e.sentLimits = limits;
            this.log.info(`Access codes: updated ${e.oldName && e.oldName !== name ? `"${e.oldName}" → ` : ''}"${name}" on the Nuki Keypad`);
            delete e.oldName;
          } else {
            const limits = this.limitsFor(e.userIndex);
            e.id = await web.addKeypadCode(name, e.code, limits);
            e.sentLimits = limits;
            const auth = e.id && (await web.listAuths()).find((a) => a.id === e.id);
            if (auth) e.authId = auth.authId;
            this.log.info(`Access codes: added "${name}" to the Nuki Keypad${e.id ? '' : ' (its Nuki Web entry will be looked up when needed)'}`);
          }
          e.synced = true;
        }
      } catch (err) {
        retry = true;
        this.log.warn(`Access codes: "${e.name || i}": ${err.message}${/ 401| 403/.test(err.message) ? ' — the Nuki Web token needs the scope "View and manage authorizations"' : ''}`);
      }
      this.saveCodes();
    }
    if (retry) { clearTimeout(this.codeRetry); this.codeRetry = setTimeout(() => this.syncCodesSoon(), this.codeRetryMs ?? 120000); }
  }

  // Home user (and code) behind a keypad unlock, for "unlocked by <name>" in Home
  codeUser(ev) {
    if (!ev) return null;
    // Fingerprint (or Nuki-app code) of a person linked in the settings to their Apple Home code
    const people = (this.lockCfg && this.lockCfg.people) || [];
    // Nuki Web lists the person's auth ID; the MQTT event carries it as authId (and the keypad's own ID as codeId)
    const person = people.find((x) => x && x.authId != null && (Number(x.authId) === ev.authId || Number(x.authId) === ev.codeId));
    if (!person && people.length && (ev.authId || ev.codeId)) this.log.info(`Keypad person authId=${ev.authId} codeId=${ev.codeId} is not linked under "Who opened"`);
    if (person && person.homeCode != null) {
      if (!this.codeMap) this.loadCodes();
      const e = this.codeMap[person.homeCode];
      const userIndex = (e && e.userIndex) || Number(person.homeUser) || null;
      if (userIndex) {
        this.log.info(`Opened by ${person.name || `Nuki person ${ev.authId}`} (Apple Home user ${userIndex})`);
        return { userIndex, credIndex: Number(person.homeCode) };
      }
    }
    if (!this.codeMap) return null;
    for (const [i, e] of Object.entries(this.codeMap)) {
      if (e.authId != null && e.userIndex && (e.authId === ev.authId || e.authId === ev.codeId)) return { userIndex: e.userIndex, credIndex: Number(i) };
    }
    return null;
  }

  startChildLock() {
    this.web();
    // Nuki Web keeps the setting it was given; read it back so changes made in the Nuki app show up too.
    const poll = async () => {
      try {
        if (!this.nukiWeb.nukiIdHex && this.nukiId) this.nukiWeb.nukiIdHex = this.nukiId.toLowerCase();
        const lock = await this.nukiWeb.get();
        const on = lock.config && lock.config.buttonEnabled === false;
        if (this.childWorker) return; // a change is being sent right now
        if (on === this.childOn) { this.childPendingUntil = 0; this.childSent = on; return; }
        if (Date.now() < (this.childPendingUntil || 0)) return; // our change is still on its way to the lock
        { this.log.info(`Child lock is ${on ? 'ON' : 'OFF'} (from Nuki Web)`); this.childSent = on; this.setChild(on); }
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
    this.doorAlerts(open);
    if (this.matter && this.lockCfg.showDoorState !== false) this.matter.setDoorOpen(open).catch((e) => this.log.warn(`Matter lock: could not update door state: ${e.message}`));
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
    const opts = { childLock: !!(this.childCfg && this.childCfg.style === 'matter') };
    try {
      this.matter = await this.openMatterLock(opts);
      if (this.nukiState !== null) this.pushLockState();
      this.writeStatus();
    } catch (e) {
      this.log.error(`Matter lock could not start: ${e.stack || e.message}`);
      if (opts.childLock || this.lockCfg.accessCodes !== false) {
        this.log.warn('Matter lock: starting again without the child-lock and access-code profile');
        try { this.matter = await this.openMatterLock({ childLock: false, accessCodes: false, unlatch: false }); if (this.nukiState !== null) this.pushLockState(); } catch (e2) { this.log.error(`Matter lock could not start: ${e2.message}`); }
      }
    }
  }

  async openMatterLock(opts) {
    const c = this.lockCfg;
    const path = require('path');
    {
      const { startMatterLock } = require('./matterLock');
      return startMatterLock({
        log: this.log,
        actuate: (a, why) => this.actuate(a, why),
        isDoorOpen: () => this.doorOpen,
        onChildLock: (on) => this.applyChild(on),
        onCodes: (list, fresh, userIndex) => this.onCodes(list, fresh, userIndex),
        onCodesRemoved: (what) => this.onCodesRemoved(what),
        onSchedule: (userIndex, sched) => this.onSchedule(userIndex, sched),
      }, {
        storagePath: path.join(this.api.user.storagePath(), 'nuki-matter-lock'),
        port: Number(c.matterPort) || 5560,
        passcode: Number(c.passcode) || 20262027,
        discriminator: Number(c.discriminator) || 3127,
        name: c.name || 'Front Door',
        serial: String(this.config.deviceId || 'nuki-lock'),
        lockState: this.nukiState !== null ? NUKI_TO_MATTER[this.nukiState] : undefined,
        doorOpen: c.showDoorState === false ? false : this.doorOpen,
        battery: this.battery,
        childLock: opts.childLock,
        accessCodes: opts.accessCodes !== false && c.accessCodes !== false,
        unlatch: opts.unlatch !== false && c.unlatch !== false,
        childLockName: this.childCfg && this.childCfg.name,
        childOn: this.childOn,
        matterLogLevel: c.matterLogLevel,
      });
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
    // unlatch = open the door (pull the latch); it is sent even when the lock is already unlocked
    const done = action === 'lock' ? (s) => s === 1 : action === 'unlatch' ? (s) => s === 5 || s === 7 : (s) => UNLOCKED_STATES.includes(s);
    if (action !== 'unlatch' && done(this.nukiState)) return Promise.resolve();
    const code = ACTIONS[action] || ACTIONS.unlock;
    const topic = `${this.prefix}/${this.nukiId}/lockAction`;
    this.log.info(`${{ lock: 'Locking', unlock: 'Unlocking', unlatch: 'Opening (unlatch)' }[action] || action} Nuki (${why}) → ${topic} = ${code}`);
    const op = { action: action === 'unlatch' ? 'unlock' : action, at: Date.now() };
    if (why === 'Home (Matter)' || why === 'Matter auto-relock') this.matterOp = op; else this.pluginOp = op;
    this.touchLock();
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
    if (s !== 1) this.touchLock();
    if (s === 254) this.log.warn('Nuki state: MOTOR BLOCKED — the lock is jammed');
    else this.log.info(`Nuki state: ${NUKI_STATE_NAMES[s] || s}`);
    for (const w of [...this.stateWaiters]) w.check(s);
    this.pushLockState();
    const nowLocked = s === 1, nowUnlocked = UNLOCKED_STATES.includes(s);
    // Report as soon as the motor starts (unlocking / locking), not when it has finished — Home's notification comes sooner
    const early = (s === 2 || s === 7) && this.prevSettled === 1 ? 'unlock' : s === 4 && this.prevSettled === 3 ? 'lock' : null;
    if (early) { this.earlyOp = { action: early, at: Date.now() }; this.reportOperation(early); }
    const settled = nowLocked && this.prevSettled === 3 ? 'lock' : nowUnlocked && this.prevSettled === 1 ? 'unlock' : null;
    const already = this.earlyOp && this.earlyOp.action === settled && Date.now() - this.earlyOp.at < 30000;
    if (settled && !already) this.reportOperation(settled);
    if (settled) this.earlyOp = null;
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
    // No fixed wait when it is already known who did it; otherwise a short wait for the lock's action event
    const known = byPlugin || (this.lastEvent && Date.now() - this.lastEvent.at < 15000);
    this.opTimer = setTimeout(() => {
      const ev = this.lastEvent && Date.now() - this.lastEvent.at < 15000 ? this.lastEvent : null;
      let source = 1; // Manual
      if (byPlugin) source = 4; // Auto (plugin auto-lock)
      else if (ev && ev.codeId > 0) source = 3; // Keypad (code / fingerprint)
      else if (ev && ev.trigger === 2) source = 5; // Button on the lock
      else if (ev && (ev.trigger === 3 || ev.trigger === 6)) source = 4; // Auto (Nuki timer / auto lock)
      else if (ev && ev.trigger === 0) source = 2; // Nuki app (Bluetooth)
      const who = source === 3 ? this.codeUser(ev) : null;
      this.lastEvent = null;
      this.matter.reportOperation(action, source, who ? who.userIndex : null, who ? who.credIndex : null).catch((e) => this.log.warn(`Matter lock: could not report ${action}: ${e.message}`));
    }, known ? 0 : (this.opWaitMs ?? 600));
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
    if (!retained) { this.lastSeen = new Date().toISOString(); if (!this.statusTimer || Date.now() - (this.statusAt || 0) > 60000) { this.statusAt = Date.now(); this.writeStatus(); } }
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
    this.broker.on('clientConnected', (cl) => {
      this.log.info(`Broker: client "${cl.id}" connected from ${cl.socket.remoteAddress}`);
      if (/^Nuki_/i.test(cl.id)) { this.nukiOnline = true; this.nukiOnlineAt = Date.now(); }
    });
    this.broker.on('clientDisconnected', (cl) => {
      this.log.info(`Broker: client "${cl.id}" disconnected`);
      if (/^Nuki_/i.test(cl.id)) this.nukiOnline = false;
    });
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
    this.lastEvent = { action, trigger, authId, codeId, at: Date.now() };
    this.touchLock();
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

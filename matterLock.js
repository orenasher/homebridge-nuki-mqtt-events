'use strict';
// Standalone Matter door lock (not bridged) with the Door Position Sensor feature.
// Runs its own matter.js node on its own port and pairs separately in Apple Home,
// the same way a native Matter lock does. Lock commands are forwarded to the Nuki
// over MQTT by the platform; the door state comes from the platform's door switch.

const fs = require('fs');

const LockState = { NotFullyLocked: 0, Locked: 1, Unlocked: 2 };
const DoorState = { Open: 0, Closed: 1 };

/**
 * @param {object} p platform hooks:
 *   log, actuate(action: 'lock'|'unlock', why: string) => Promise<void>, isDoorOpen() => boolean|null
 * @param {object} o options: storagePath, port, passcode, discriminator, name, serial, lockState, doorOpen
 */
// Matter BatChargeLevel: 0 ok, 1 warning, 2 critical
function batLevel(b) {
  if (b.critical) return 2;
  if (b.percent != null && b.percent <= 20) return 1;
  return 0;
}
// Matter BatChargeState: 0 unknown, 1 charging, 2 full, 3 not charging
function chargeState(b) {
  if (b.charging == null) return 0;
  if (b.charging) return b.percent >= 100 ? 2 : 1;
  return 3;
}

async function startMatterLock(p, o) {
  fs.mkdirSync(o.storagePath, { recursive: true });

  const main = require('@matter/main');
  const { Environment, ServerNode, VendorId, Logger } = main;
  const { DoorLockDevice } = require('@matter/main/devices/door-lock');
  const { DoorLockServer } = require('@matter/main/behaviors/door-lock');
  const { PowerSourceServer } = require('@matter/main/behaviors/power-source');

  const vars = Environment.default.vars;
  vars.set('path.root', o.storagePath);
  vars.set('storage.path', o.storagePath);
  try { Logger.level = o.matterLogLevel || 'warn'; } catch (e) { /* older matter.js */ }

  class NukiDoorLockServer extends DoorLockServer.with('DoorPositionSensor') {
    // Called by matter.js for Home commands (source Remote) and for its own auto-relock (source Auto).
    async handleLockOperation(op) {
      const auto = Number(op.source) === 4; // OperationSource.Auto (7 = Remote)
      if (op.actuation === 'lock' && p.isDoorOpen() === true) {
        p.log.warn(`Matter lock: refused to lock${auto ? ' (auto-relock)' : ''} while the door is open`);
        throw new Error('Door is open');
      }
      await p.actuate(op.actuation === 'lock' ? 'lock' : 'unlock', auto ? 'Matter auto-relock' : 'Home (Matter)');
    }
  }

  const node = await ServerNode.create({
    id: 'nuki-door-lock',
    network: { port: o.port },
    commissioning: { passcode: o.passcode, discriminator: o.discriminator },
    productDescription: { name: o.name, deviceType: DoorLockDevice.deviceType },
    basicInformation: {
      vendorName: 'Oren Asher',
      vendorId: VendorId(0xfff1),
      nodeLabel: o.name.slice(0, 32),
      productName: 'Nuki Door Lock (MQTT)',
      productLabel: 'Nuki Door Lock',
      productId: 0x8001,
      serialNumber: o.serial,
      uniqueId: `nuki-${o.serial}`,
    },
  });

  const b = o.battery || {};
  const behaviors = [NukiDoorLockServer, PowerSourceServer.with('Battery', 'Rechargeable')];
  const initial = {
    id: 'lock',
    doorLock: {
      lockState: o.lockState ?? LockState.Locked,
      lockType: 0, // dead bolt
      actuatorEnabled: true,
      operatingMode: 0,
      doorState: o.doorOpen ? DoorState.Open : DoorState.Closed,
      autoRelockTime: 0,
    },
    powerSource: {
      status: 1, // Active
      order: 0,
      description: 'Battery',
      batPercentRemaining: b.percent != null ? Math.round(b.percent * 2) : null,
      batChargeLevel: batLevel(b),
      batReplacementNeeded: false,
      batReplaceability: 1, // NotReplaceable (built-in rechargeable)
      batChargeState: chargeState(b),
      batFunctionalWhileCharging: true,
      endpointList: [],
    },
  };
  const endpoint = await node.add(DoorLockDevice.with(...behaviors), initial);

  // Log what Home writes to the lock, so it is visible how "Lock After Closing" is configured.
  const ev = endpoint.events.doorLock;
  if (ev.autoRelockTime$Changed) {
    ev.autoRelockTime$Changed.on((v) => p.log.info(`Matter lock: Home set autoRelockTime = ${v} s`));
  }
  if (ev.operatingMode$Changed) {
    ev.operatingMode$Changed.on((v) => p.log.info(`Matter lock: Home set operatingMode = ${v}`));
  }

  // Child lock as a second lock on the same Matter accessory (Home shows a secondary lock as its own
  // section with Locked / Unlocked inside the accessory page). Locked = the button on the Nuki is disabled.
  let child = null;
  if (o.childLock) {
    class ChildLockServer extends DoorLockServer {
      async handleLockOperation(op) {
        await p.onChildLock(op.actuation === 'lock');
      }
    }
    let ChildDevice = DoorLockDevice.with(ChildLockServer);
    try {
      const { FixedLabelServer } = require('@matter/main/behaviors/fixed-label');
      ChildDevice = ChildDevice.with(FixedLabelServer);
    } catch (e) { /* label is cosmetic */ }
    const childInit = {
      id: 'childlock',
      doorLock: { lockState: o.childOn ? LockState.Locked : LockState.Unlocked, lockType: 0, actuatorEnabled: true, operatingMode: 0 },
    };
    if (ChildDevice.behaviors && ChildDevice.behaviors.fixedLabel) childInit.fixedLabel = { labelList: [{ label: 'name', value: o.childLockName || 'Child Lock' }] };
    child = await node.add(ChildDevice, childInit);
  }

  await node.start();

  const codes = node.state.commissioning.pairingCodes;
  if (!node.state.commissioning.commissioned) {
    p.log.warn(`Matter lock "${o.name}" is not paired yet. In Home: Add Accessory → More options → enter code ${codes.manualPairingCode}`);
    p.log.info(`Matter lock QR payload: ${codes.qrPairingCode}`);
  } else {
    p.log.info(`Matter lock "${o.name}" online on port ${o.port} (paired; code ${codes.manualPairingCode})`);
  }

  return {
    endpoint,
    async setLockState(state) {
      if (state === undefined || state === null) return;
      await endpoint.set({ doorLock: { lockState: state } });
    },
    async setDoorOpen(open) {
      await endpoint.set({ doorLock: { doorState: open ? DoorState.Open : DoorState.Closed } });
    },
    // Motor blocked: lockState NotFullyLocked (Home shows "Jammed") + DoorLockAlarm LockJammed event
    async reportJam() {
      await endpoint.set({ doorLock: { lockState: LockState.NotFullyLocked } });
      await endpoint.act((agent) => {
        const dl = agent.get(NukiDoorLockServer);
        dl.events.doorLockAlarm.emit({ alarmCode: 0 }, agent.context);
      });
    },
    // LockOperation event for a lock/unlock done outside Matter (source: 1 manual, 2 Nuki app, 3 keypad, 4 auto, 5 button)
    async reportOperation(action, source) {
      await endpoint.act((agent) => {
        const dl = agent.get(NukiDoorLockServer);
        dl.events.lockOperation.emit({
          lockOperationType: action === 'lock' ? 0 : 1,
          operationSource: source,
          userIndex: null,
          fabricIndex: null,
          sourceNode: null,
          credentials: null,
        }, agent.context);
      });
    },
    async setBattery(bat) {
      const ps = { batChargeLevel: batLevel(bat), batChargeState: chargeState(bat) };
      if (bat.percent != null) ps.batPercentRemaining = Math.round(bat.percent * 2);
      await endpoint.set({ powerSource: ps });
    },
    async setChildLock(on) {
      if (child) await child.set({ doorLock: { lockState: on ? LockState.Locked : LockState.Unlocked } });
    },
    autoRelockTime() { return Number(endpoint.state.doorLock.autoRelockTime) || 0; },
    lockState() { return endpoint.state.doorLock.lockState; },
    async close() { await node.close(); },
  };
}

module.exports = { startMatterLock, LockState, DoorState };

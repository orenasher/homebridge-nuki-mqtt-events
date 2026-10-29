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
async function startMatterLock(p, o) {
  fs.mkdirSync(o.storagePath, { recursive: true });

  const main = require('@matter/main');
  const { Environment, ServerNode, VendorId, Logger } = main;
  const { DoorLockDevice } = require('@matter/main/devices/door-lock');
  const { DoorLockServer } = require('@matter/main/behaviors/door-lock');

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

  const endpoint = await node.add(DoorLockDevice.with(NukiDoorLockServer), {
    id: 'lock',
    doorLock: {
      lockState: o.lockState ?? LockState.Locked,
      lockType: 0, // dead bolt
      actuatorEnabled: true,
      operatingMode: 0,
      doorState: o.doorOpen ? DoorState.Open : DoorState.Closed,
      autoRelockTime: 0,
    },
  });

  // Log what Home writes to the lock, so it is visible how "Lock After Closing" is configured.
  const ev = endpoint.events.doorLock;
  if (ev.autoRelockTime$Changed) {
    ev.autoRelockTime$Changed.on((v) => p.log.info(`Matter lock: Home set autoRelockTime = ${v} s`));
  }
  if (ev.operatingMode$Changed) {
    ev.operatingMode$Changed.on((v) => p.log.info(`Matter lock: Home set operatingMode = ${v}`));
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
    autoRelockTime() { return Number(endpoint.state.doorLock.autoRelockTime) || 0; },
    lockState() { return endpoint.state.doorLock.lockState; },
    async close() { await node.close(); },
  };
}

module.exports = { startMatterLock, LockState, DoorState };

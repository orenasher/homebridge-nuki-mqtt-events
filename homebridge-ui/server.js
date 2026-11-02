'use strict';
// Server side of the settings page: status from the running plugin, the IP for the Nuki app, and a Nuki Web check.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { NukiWeb } = require('../nukiWeb');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.dir = path.join(this.homebridgeStoragePath, 'nuki-matter-lock');
    this.onRequest('/status', () => this.status());
    this.onRequest('/nuki-web', (p) => this.nukiWeb(p || {}));
    this.ready();
  }

  status() {
    let status = null;
    try { status = JSON.parse(fs.readFileSync(path.join(this.dir, 'ui-status.json'), 'utf8')); } catch (e) { /* not running yet */ }
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }
    return { status, ips };
  }

  // Checks the token and lists the people on the lock (for "who opened")
  async nukiWeb({ token, nukiId }) {
    if (!token) throw new RequestError('no token', { code: 'noToken' });
    const web = new NukiWeb(String(token).trim(), nukiId || null, null);
    let lock;
    try {
      lock = await web.get();
    } catch (e) {
      throw new RequestError(e.message, { code: / 401| 403/.test(e.message) ? 'badToken' : 'failed' });
    }
    const out = { name: lock && lock.name, smartlockId: web.id, canConfig: true, canAuths: true, people: [] };
    try {
      const auths = await web.listAuths();
      // People on the keypad (code / fingerprint) — not the codes this plugin made from Home, not app users or Nuki Web
      const ours = /^(Apple Home|Home)( \d+)?$/;
      out.people = auths
        .filter((a) => a.type === 13 && !ours.test(String(a.name || '').trim()))
        .map((a) => ({ authId: a.authId, name: a.name, type: a.type, fingerprints: a.fingerprints ? Object.keys(a.fingerprints).length : 0 }))
        .sort((x, y) => (y.fingerprints > 0) - (x.fingerprints > 0));
      out.leftovers = auths.filter((a) => a.type === 13 && /^Home \d+$/.test(String(a.name || '').trim())).length;
    } catch (e) {
      if (/ 401| 403/.test(e.message)) out.canAuths = false; else throw new RequestError(e.message, { code: 'failed' });
    }
    return out;
  }
}

(() => new UiServer())();

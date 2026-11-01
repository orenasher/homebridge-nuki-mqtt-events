'use strict';
// Minimal Nuki Web API client (no dependencies) — used for the child lock (Smart Lock button on/off).
const https = require('https');

function request(token, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      host: 'api.nuki.io', path, method,
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        if (res.statusCode >= 300) {
          let msg = out;
          try { msg = JSON.parse(out).detailMessage || out; } catch (e) { /* not json */ }
          return reject(new Error(`Nuki Web ${method} ${path} → ${res.statusCode}: ${msg}`));
        }
        try { resolve(out ? JSON.parse(out) : null); } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Nuki Web request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class NukiWeb {
  constructor(token, nukiIdHex, smartlockId) {
    this.token = token;
    this.nukiIdHex = nukiIdHex ? String(nukiIdHex).toLowerCase() : null;
    this.id = smartlockId ? Number(smartlockId) : null;
  }

  // smartlockId = device type prefix + Nuki ID (hex), e.g. 0x5_4e2cc127
  async findId() {
    if (this.id) return this.id;
    const locks = await request(this.token, 'GET', '/smartlock');
    if (!Array.isArray(locks) || !locks.length) throw new Error('Nuki Web: no smart locks on this account');
    const match = this.nukiIdHex && locks.find((l) => Number(l.smartlockId).toString(16).toLowerCase().endsWith(this.nukiIdHex));
    const lock = match || (locks.length === 1 ? locks[0] : null);
    if (!lock) throw new Error('Nuki Web: several locks on this account — set the Nuki device ID or the Smart Lock ID in the settings');
    this.id = lock.smartlockId;
    return this.id;
  }

  async get() {
    const id = await this.findId();
    return request(this.token, 'GET', `/smartlock/${id}`);
  }

  // The Web API only accepts the whole config object.
  async setButtonEnabled(enabled) {
    const lock = await this.get();
    const cfg = { ...lock.config, buttonEnabled: enabled };
    await request(this.token, 'POST', `/smartlock/${this.id}/config`, cfg);
  }
}

module.exports = { NukiWeb };

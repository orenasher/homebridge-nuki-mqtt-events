'use strict';
// Minimal, dependency-free MQTT 3.1 / 3.1.1 broker for the local LAN.
// Supports: CONNECT (+auth, will), PUBLISH QoS 0/1/2 inbound, retained messages,
// SUBSCRIBE/UNSUBSCRIBE with + and # wildcards, PINGREQ, DISCONNECT, keep-alive.
// Outbound delivery is QoS 0 (subscriptions are granted QoS 0).
const net = require('net');
const { EventEmitter } = require('events');

const T = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, PUBREC: 5, PUBREL: 6, PUBCOMP: 7,
  SUBSCRIBE: 8, SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };

function encLen(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
function encStr(s) {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2); l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
}
function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(body.length), body]);
}
function publishPacket(topic, payload, retain) {
  return packet(T.PUBLISH, retain ? 1 : 0, Buffer.concat([encStr(topic), payload]));
}
function topicMatches(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split('/'), t = topic.split('/');
  if (topic.startsWith('$') && (f[0] === '#' || f[0] === '+')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

class Client {
  constructor(broker, socket) {
    this.broker = broker;
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.subs = new Set();
    this.id = null;
    this.connected = false;
    this.will = null;
    this.keepAlive = 0;
    this.timer = null;
    this.inflight2 = new Set();
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', () => {});
    socket.on('close', () => this.onClose());
  }

  send(b) { if (!this.socket.destroyed) this.socket.write(b); }

  touch() {
    clearTimeout(this.timer);
    if (this.keepAlive > 0) this.timer = setTimeout(() => this.socket.destroy(), this.keepAlive * 1500);
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      let mult = 1, len = 0, i = 1, b;
      do {
        if (i >= this.buf.length) return;
        b = this.buf[i++]; len += (b & 127) * mult; mult *= 128;
        if (i > 5) return this.socket.destroy();
      } while (b & 128);
      if (len > 1024 * 1024) return this.socket.destroy();
      if (this.buf.length < i + len) return;
      const header = this.buf[0];
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      try { this.handle(header >> 4, header & 15, body); } catch (e) {
        this.broker.emit('warn', `bad packet from ${this.id || 'unknown'}: ${e.message}`);
        this.socket.destroy();
        return;
      }
    }
  }

  handle(type, flags, body) {
    this.touch();
    if (!this.connected && type !== T.CONNECT) return this.socket.destroy();
    let p = 0;
    const u16 = () => { const v = body.readUInt16BE(p); p += 2; return v; };
    const str = () => { const l = u16(); const s = body.subarray(p, p + l); p += l; return s; };

    switch (type) {
      case T.CONNECT: {
        if (this.connected) return this.socket.destroy();
        str(); // protocol name
        const level = body[p++];
        const cf = body[p++];
        this.keepAlive = u16();
        if (level !== 3 && level !== 4) { this.send(packet(T.CONNACK, 0, Buffer.from([0, 1]))); return this.socket.end(); }
        this.id = str().toString() || `auto-${Math.random().toString(16).slice(2, 10)}`;
        if (cf & 0x04) {
          const wt = str().toString(); const wp = Buffer.from(str());
          this.will = { topic: wt, payload: wp, retain: !!(cf & 0x20) };
        }
        const user = cf & 0x80 ? str().toString() : undefined;
        const pass = cf & 0x40 ? str().toString() : undefined;
        if (!this.broker.authenticate(user, pass)) {
          this.broker.emit('warn', `rejected login from ${this.socket.remoteAddress} (user "${user || ''}")`);
          this.send(packet(T.CONNACK, 0, Buffer.from([0, 5])));
          return this.socket.end();
        }
        const old = this.broker.clients.get(this.id);
        if (old && old !== this) { old.will = null; old.socket.destroy(); }
        this.broker.clients.set(this.id, this);
        this.connected = true;
        this.touch();
        this.send(packet(T.CONNACK, 0, Buffer.from([0, 0])));
        this.broker.emit('clientConnected', this);
        return;
      }
      case T.PUBLISH: {
        const qos = (flags >> 1) & 3;
        const retain = !!(flags & 1);
        const topic = str().toString();
        let mid = 0;
        if (qos > 0) mid = u16();
        const payload = Buffer.from(body.subarray(p));
        if (qos === 1) this.send(packet(T.PUBACK, 0, Buffer.from([mid >> 8, mid & 255])));
        if (qos === 2) {
          this.send(packet(T.PUBREC, 0, Buffer.from([mid >> 8, mid & 255])));
          if (this.inflight2.has(mid)) return; // duplicate
          this.inflight2.add(mid);
        }
        this.broker.publish(topic, payload, retain, this);
        return;
      }
      case T.PUBREL: {
        const mid = u16();
        this.inflight2.delete(mid);
        this.send(packet(T.PUBCOMP, 0, Buffer.from([mid >> 8, mid & 255])));
        return;
      }
      case T.PUBACK: case T.PUBREC: case T.PUBCOMP: return;
      case T.SUBSCRIBE: {
        const mid = u16();
        const granted = [];
        const added = [];
        while (p < body.length) {
          const f = str().toString(); p++; // requested qos ignored
          this.subs.add(f); granted.push(0); added.push(f);
        }
        this.send(packet(T.SUBACK, 0, Buffer.concat([Buffer.from([mid >> 8, mid & 255]), Buffer.from(granted)])));
        for (const f of added) {
          for (const [topic, payload] of this.broker.retained) {
            if (topicMatches(f, topic)) this.send(publishPacket(topic, payload, true));
          }
        }
        return;
      }
      case T.UNSUBSCRIBE: {
        const mid = u16();
        while (p < body.length) this.subs.delete(str().toString());
        this.send(packet(T.UNSUBACK, 0, Buffer.from([mid >> 8, mid & 255])));
        return;
      }
      case T.PINGREQ: this.send(packet(T.PINGRESP, 0, Buffer.alloc(0))); return;
      case T.DISCONNECT: this.will = null; this.socket.end(); return;
      default: this.socket.destroy();
    }
  }

  onClose() {
    clearTimeout(this.timer);
    if (!this.connected) return;
    this.connected = false;
    if (this.broker.clients.get(this.id) === this) this.broker.clients.delete(this.id);
    if (this.will) this.broker.publish(this.will.topic, this.will.payload, this.will.retain, null);
    this.broker.emit('clientDisconnected', this);
  }
}

class MiniBroker extends EventEmitter {
  constructor({ username, password } = {}) {
    super();
    this.username = username || '';
    this.password = password || '';
    this.clients = new Map();
    this.retained = new Map();
    this.server = net.createServer((s) => new Client(this, s));
  }

  authenticate(user, pass) {
    if (!this.username) return true;
    return user === this.username && (pass || '') === this.password;
  }

  publish(topic, payload, retain, from) {
    if (retain) {
      if (payload.length === 0) this.retained.delete(topic);
      else this.retained.set(topic, payload);
      this.emit('retainChanged');
    }
    this.emit('message', topic, payload, from);
    const pkt = publishPacket(topic, payload, false);
    for (const c of this.clients.values()) {
      for (const f of c.subs) {
        if (topicMatches(f, topic)) { c.send(pkt); break; }
      }
    }
  }

  listen(port, host) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => { this.server.off('error', reject); resolve(); });
    });
  }

  close() {
    for (const c of this.clients.values()) c.socket.destroy();
    this.server.close();
  }
}

module.exports = { MiniBroker, topicMatches };

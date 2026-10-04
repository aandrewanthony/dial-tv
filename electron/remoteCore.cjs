// Remote Control: pure pairing / token / rate-limit / WebSocket-framing logic (no Electron,
// no sockets) so it can be unit tested. electron/remote.cjs wires it to an HTTP server.
const crypto = require('node:crypto');

const CODE_LEN = 6;
/** Wrong codes per address before it is locked out, and for how long. */
const MAX_TRIES = 5;
const TRY_WINDOW_MS = 60_000;
const LOCK_MS = 5 * 60_000;
/** Wrong codes from all addresses together before the code is replaced. */
const ROTATE_AFTER = 10;
const MAX_DEVICES = 8;

/** A 6-digit code (leading zeros allowed), uniformly random. */
function newPairingCode(randInt = crypto.randomInt) {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += String(randInt(10));
  return s;
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const newId = () => crypto.randomBytes(6).toString('hex');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** Constant-time string compare (different lengths → false). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Failed-attempt limiter per key (client address): after `max` failures inside `windowMs`
 * the key is locked for `lockMs`. A success clears it.
 */
function createRateLimiter({ max = MAX_TRIES, windowMs = TRY_WINDOW_MS, lockMs = LOCK_MS } = {}) {
  const map = new Map(); // key → { fails: number[], until: number }
  const prune = (now) => {
    if (map.size < 1000) return;
    for (const [k, v] of map) if (v.until <= now && !v.fails.some((t) => now - t < windowMs)) map.delete(k);
  };
  return {
    /** { ok: true } or { ok: false, retryAfterMs }. */
    check(key, now = Date.now()) {
      const e = map.get(key);
      if (e && e.until > now) return { ok: false, retryAfterMs: e.until - now };
      return { ok: true };
    },
    fail(key, now = Date.now()) {
      prune(now);
      const e = map.get(key) ?? { fails: [], until: 0 };
      e.fails = e.fails.filter((t) => now - t < windowMs);
      e.fails.push(now);
      if (e.fails.length >= max) { e.until = now + lockMs; e.fails = []; }
      map.set(key, e);
      return e.until > now ? { locked: true, retryAfterMs: e.until - now } : { locked: false, left: max - e.fails.length };
    },
    reset(key) { map.delete(key); },
  };
}

/** Phone-supplied device name: printable, short. */
function cleanName(n) {
  const s = String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
  return s || 'Phone';
}

/**
 * Pairing + device registry. Devices are stored with a SHA-256 of their token only.
 * `devices` is the persisted list ({ id, name, tokenHash, created, lastSeen }).
 */
function createPairing({ devices = [], randInt, limiter = createRateLimiter(), now = () => Date.now(), onChange } = {}) {
  let list = devices.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string').slice(0, MAX_DEVICES);
  let code = newPairingCode(randInt);
  let wrong = 0; // wrong codes (all addresses) since the code was made
  const changed = () => onChange?.(list.slice());
  const rotate = () => { code = newPairingCode(randInt); wrong = 0; };
  return {
    get code() { return code; },
    rotate() { rotate(); changed(); },
    devices: () => list.map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen })),
    stored: () => list.slice(),
    /**
     * Try a pairing code from `addr`. → { ok: true, token, device } |
     * { ok: false, error: 'locked', retryAfterMs } | { ok: false, error: 'bad', left }.
     */
    pair(input, addr, name) {
      const t = now();
      const gate = limiter.check(addr, t);
      if (!gate.ok) return { ok: false, error: 'locked', retryAfterMs: gate.retryAfterMs };
      const typed = String(input ?? '').replace(/\D/g, '');
      if (typed.length !== CODE_LEN || !safeEqual(typed, code)) {
        const r = limiter.fail(addr, t);
        if (++wrong >= ROTATE_AFTER) { rotate(); changed(); }
        return r.locked ? { ok: false, error: 'locked', retryAfterMs: r.retryAfterMs } : { ok: false, error: 'bad', left: r.left };
      }
      limiter.reset(addr);
      const token = newToken();
      const device = { id: newId(), name: cleanName(name), tokenHash: hashToken(token), created: t, lastSeen: t };
      list = [...list, device];
      while (list.length > MAX_DEVICES) list.shift(); // oldest pairing drops off
      rotate(); // one code, one phone
      changed();
      return { ok: true, token, device: { id: device.id, name: device.name } };
    },
    /** The device for a token, or null. Updates lastSeen (not persisted on every message). */
    verify(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const h = hashToken(token);
      const d = list.find((x) => safeEqual(x.tokenHash, h));
      if (d) d.lastSeen = now();
      return d ?? null;
    },
    revoke(id) {
      const before = list.length;
      list = list.filter((d) => d.id !== id);
      if (list.length !== before) changed();
      return list.length !== before;
    },
  };
}

/** Commands the phone may send, validated and normalized; anything else → null. */
const SIMPLE = new Set(['chup', 'chdown', 'play', 'mute', 'volup', 'voldown', 'last', 'guide']);
function validateCommand(c) {
  if (!c || typeof c !== 'object' || typeof c.type !== 'string') return null;
  if (SIMPLE.has(c.type)) return { type: c.type };
  if (c.type === 'number' && typeof c.value === 'string' && /^\d{1,5}$/.test(c.value)) return { type: 'number', value: c.value };
  if (c.type === 'tune' && typeof c.id === 'string' && c.id.length > 0 && c.id.length <= 512) return { type: 'tune', id: c.id };
  return null;
}

/** LAN IPv4 addresses from os.networkInterfaces(), private ranges first. */
function lanAddresses(ifaces) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      const fam = a.family === 4 ? 'IPv4' : a.family;
      if (fam !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address });
    }
  }
  const rank = (ip, name) => {
    let r = /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
    if (/vmware|virtual|vbox|hyper-v|vethernet|wsl|docker|tailscale|zerotier/i.test(name)) r += 10;
    return r;
  };
  return out.sort((a, b) => rank(a.address, a.name) - rank(b.address, b.name)).map((a) => a.address);
}

/** Host header must be an IP literal or localhost (blocks DNS-rebinding pages). */
function hostAllowed(host) {
  if (typeof host !== 'string') return false;
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^[0-9a-f:]+$/i.test(h);
}

// ---- WebSocket (RFC 6455), text frames only ----
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (key) => crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');

/** Server → client frame (unmasked). opcode 1 text, 8 close, 10 pong. */
function encodeFrame(payload, opcode = 1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = data.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, data]);
}

/**
 * Incremental parser for client frames. push(chunk) → [{ opcode, data: Buffer }].
 * Client frames must be masked; fragmented messages are reassembled; size is capped.
 * Throws on protocol errors (caller closes the socket).
 */
function createFrameParser(maxPayload = 16 * 1024) {
  let buf = Buffer.alloc(0);
  let frag = null; // { opcode, parts: Buffer[], size }
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out = [];
      for (;;) {
        if (buf.length < 2) break;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (!masked) throw new Error('unmasked client frame');
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) {
          if (buf.length < 10) break;
          const big = buf.readBigUInt64BE(2);
          if (big > BigInt(maxPayload)) throw new Error('frame too large');
          len = Number(big); off = 10;
        }
        if (len > maxPayload) throw new Error('frame too large');
        if (buf.length < off + 4 + len) break;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.alloc(len);
        for (let i = 0; i < len; i++) data[i] = buf[off + 4 + i] ^ mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (opcode >= 8) { out.push({ opcode, data }); continue; } // control frames may interleave
        if (opcode !== 0) {
          if (frag) throw new Error('unexpected new message');
          if (fin) { out.push({ opcode, data }); continue; }
          frag = { opcode, parts: [data], size: len };
        } else {
          if (!frag) throw new Error('unexpected continuation');
          frag.parts.push(data);
          frag.size += len;
          if (frag.size > maxPayload) throw new Error('message too large');
          if (fin) { out.push({ opcode: frag.opcode, data: Buffer.concat(frag.parts) }); frag = null; }
        }
      }
      return out;
    },
  };
}

/** Client → server frame (masked); used by tests and tools. */
function encodeClientFrame(text, opcode = 1) {
  const data = Buffer.from(String(text));
  const mask = crypto.randomBytes(4);
  const len = data.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

module.exports = {
  CODE_LEN, MAX_TRIES, TRY_WINDOW_MS, LOCK_MS, ROTATE_AFTER, MAX_DEVICES,
  newPairingCode, newToken, hashToken, safeEqual, createRateLimiter, createPairing, cleanName,
  validateCommand, lanAddresses, hostAllowed, acceptKey, encodeFrame, encodeClientFrame, createFrameParser,
};

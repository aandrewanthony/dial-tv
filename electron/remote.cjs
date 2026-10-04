// Remote Control server: a tiny HTTP + WebSocket server on the LAN that serves the phone
// remote page (remote-page.html), pairs phones with a 6-digit code, and relays their commands.
// No Electron imports: main.cjs wires it up, and tests run it in plain Node.
const http = require('node:http');
const os = require('node:os');
const core = require('./remoteCore.cjs');

const DEFAULT_PORTS = [47800, 47801, 47802, 47803, 47804, 0]; // 0 = any free port
const MAX_BODY = 1024;
const MAX_STATE = 64 * 1024;
const CMD_PER_SEC = 20;

const clientAddr = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  };
}

/**
 * opts: html (phone page), devices (persisted list), onDevices(list) to persist,
 * onCommand(cmd, device), onChange() when status changes (paired, revoked, code rotated),
 * ports, host, interfaces (os.networkInterfaces override for tests), now.
 */
function createRemoteServer(opts) {
  const { html, onCommand, onChange, onDevices, ports = DEFAULT_PORTS, host = '0.0.0.0' } = opts;
  const pairing = core.createPairing({
    devices: opts.devices || [],
    now: opts.now,
    randInt: opts.randInt,
    onChange: (list) => { onDevices?.(list); onChange?.(); },
  });
  const sockets = new Set(); // { sock, deviceId, bucket, last }
  let server = null;
  let port = 0;
  let lastState = null;

  function send(c, obj) {
    try { c.sock.write(core.encodeFrame(JSON.stringify(obj))); } catch { /* closed */ }
  }
  function forget(c) {
    if (sockets.delete(c) && c.deviceId) onChange?.();
  }
  function closeConn(c, code = 1000) {
    forget(c);
    try {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code, 0);
      c.sock.end(core.encodeFrame(b, 8));
    } catch { /* already gone */ }
    setTimeout(() => c.sock.destroy(), 1000).unref?.();
  }

  function onMessage(c, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return closeConn(c, 1003); }
    if (!msg || typeof msg !== 'object') return closeConn(c, 1003);
    // Every message carries the token; a revoked token stops working immediately.
    const device = pairing.verify(msg.t);
    if (!device) { send(c, { type: 'unauthorized' }); return closeConn(c, 4001); }
    const fresh = c.deviceId !== device.id;
    c.deviceId = device.id;
    if (fresh) onChange?.(); // shows as connected on the desktop
    if (msg.type === 'hello') {
      send(c, { type: 'hello', name: device.name });
      if (lastState) send(c, { type: 'state', state: lastState });
      return;
    }
    if (msg.type === 'cmd') {
      const now = Date.now();
      if (now - c.last >= 1000) { c.last = now; c.bucket = 0; }
      if (++c.bucket > CMD_PER_SEC) return; // flood: drop
      const cmd = core.validateCommand(msg.cmd);
      if (cmd) onCommand?.(cmd, { id: device.id, name: device.name });
    }
  }

  function onUpgrade(req, sock) {
    const fail = (status) => { try { sock.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* */ } };
    const url = String(req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== '/ws' || !/websocket/i.test(String(req.headers.upgrade)) || !key || req.headers['sec-websocket-version'] !== '13') return fail('400 Bad Request');
    if (!core.hostAllowed(req.headers.host)) return fail('403 Forbidden');
    // Browsers send Origin: it must be this server's own page.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return fail('403 Forbidden');
    sock.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${core.acceptKey(key)}`,
      '', '',
    ].join('\r\n'));
    sock.setNoDelay(true);
    sock.setTimeout(10 * 60_000, () => sock.destroy()); // idle
    const c = { sock, deviceId: null, bucket: 0, last: 0 };
    sockets.add(c);
    const parser = core.createFrameParser();
    sock.on('data', (chunk) => {
      let frames;
      try { frames = parser.push(chunk); } catch { return closeConn(c, 1002); }
      for (const f of frames) {
        if (f.opcode === 1) onMessage(c, f.data.toString('utf8'));
        else if (f.opcode === 8) return closeConn(c);
        else if (f.opcode === 9) { try { sock.write(core.encodeFrame(f.data, 10)); } catch { /* */ } }
        else if (f.opcode === 2) return closeConn(c, 1003); // text only
      }
    });
    sock.on('close', () => forget(c));
    sock.on('error', () => forget(c));
  }

  function onRequest(req, res) {
    const json = (status, obj) => {
      res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json' }));
      res.end(JSON.stringify(obj));
    };
    if (!core.hostAllowed(req.headers.host)) { res.writeHead(403, securityHeaders()); return res.end(); }
    const url = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, securityHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' ws://${req.headers.host}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      }));
      return res.end(html);
    }
    if (req.method === 'POST' && url === '/pair') {
      // Same-origin only (a page elsewhere can't try codes from the phone's browser).
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return json(403, { error: 'origin' });
      let body = '';
      let tooBig = false;
      req.setEncoding('utf8');
      req.on('data', (d) => { body += d; if (body.length > MAX_BODY) { tooBig = true; req.destroy(); } });
      req.on('end', () => {
        if (tooBig) return;
        let p;
        try { p = JSON.parse(body); } catch { return json(400, { error: 'bad request' }); }
        const r = pairing.pair(p?.code, clientAddr(req), p?.name);
        if (r.ok) return json(200, { token: r.token, name: r.device.name });
        if (r.error === 'locked') return json(429, { error: 'locked', retryAfterSec: Math.ceil(r.retryAfterMs / 1000) });
        return json(403, { error: 'wrong code', left: r.left });
      });
      return;
    }
    res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain' }));
    res.end('Not found');
  }

  function listenOn(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(onRequest);
      s.on('upgrade', onUpgrade);
      s.headersTimeout = 10_000;
      s.requestTimeout = 15_000;
      const onErr = (e) => { s.close(); reject(e); };
      s.once('error', onErr);
      s.listen(p, host, () => {
        s.off('error', onErr);
        s.on('error', () => {});
        resolve(s);
      });
    });
  }

  return {
    async start() {
      if (server) return port;
      let lastErr;
      for (const p of ports) {
        try {
          server = await listenOn(p);
          port = server.address().port;
          return port;
        } catch (e) {
          lastErr = e;
          if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') break;
        }
      }
      throw lastErr ?? new Error('could not listen');
    },
    async stop() {
      const s = server;
      server = null;
      port = 0;
      for (const c of [...sockets]) closeConn(c, 1001);
      if (s) await new Promise((r) => s.close(() => r()));
    },
    get running() { return !!server; },
    get port() { return port; },
    status() {
      const ips = core.lanAddresses(opts.interfaces ? opts.interfaces() : os.networkInterfaces());
      const ip = ips[0] ?? '127.0.0.1';
      return {
        on: !!server,
        port,
        url: server ? `http://${ip}:${port}/` : null,
        urls: server ? ips.map((a) => `http://${a}:${port}/`) : [],
        code: server ? pairing.code : null,
        devices: pairing.devices().map((d) => ({ ...d, connected: [...sockets].some((c) => c.deviceId === d.id) })),
      };
    },
    revoke(id) {
      const ok = pairing.revoke(id);
      for (const c of [...sockets]) if (c.deviceId === id) { send(c, { type: 'unauthorized' }); closeConn(c, 4001); }
      return ok;
    },
    rotate() { pairing.rotate(); },
    /** Push now-playing to every paired phone. */
    publish(state) {
      const text = JSON.stringify(state ?? null);
      if (text.length > MAX_STATE) return false;
      lastState = JSON.parse(text);
      for (const c of sockets) if (c.deviceId) send(c, { type: 'state', state: lastState });
      return true;
    },
    devicesForStore: () => pairing.stored(),
  };
}

module.exports = { createRemoteServer, DEFAULT_PORTS };

// @vitest-environment node
// Starts the real Remote Control server (electron/remote.cjs, no Electron needed) on
// 127.0.0.1 and talks to it like a phone: HTTP pairing, then WebSocket with Node's built-in
// WebSocket client (an independent RFC 6455 implementation) and a raw-socket client.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import net from 'node:net';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRemoteServer } = require('../../electron/remote.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('../../electron/remoteCore.cjs');

type Srv = ReturnType<typeof createRemoteServer>;
let srv: Srv | null = null;
afterEach(async () => { await srv?.stop(); srv = null; });

const LOOPBACK = () => ({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: false }] });

async function startServer(extra: Record<string, unknown> = {}) {
  const commands: unknown[] = [];
  let stored: unknown[] = [];
  srv = createRemoteServer({
    html: '<!doctype html><title>Dial TV Remote</title>',
    ports: [0],
    host: '127.0.0.1',
    interfaces: LOOPBACK,
    onCommand: (cmd: unknown, dev: { name: string }) => commands.push({ cmd, from: dev.name }),
    onDevices: (list: unknown[]) => { stored = list; },
    ...extra,
  });
  const port: number = await srv.start();
  return { port, base: `http://127.0.0.1:${port}`, commands, stored: () => stored };
}

const pair = (base: string, code: string, name = 'Test phone') =>
  fetch(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });

/** Node's WebSocket, collecting messages; resolves once open. */
function openWs(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: { type: string; state?: unknown; name?: string }[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (e) => { msgs.push(JSON.parse(String(e.data))); waiters.splice(0).forEach((w) => w()); };
  const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
  const next = (type: string) => new Promise<(typeof msgs)[number]>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${type} message`)), 3000);
    const check = () => {
      const i = msgs.findIndex((m) => m.type === type);
      if (i >= 0) { clearTimeout(t); resolve(msgs.splice(i, 1)[0]); } else waiters.push(check);
    };
    check();
  });
  const opened = new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')); });
  return { ws, next, closed, opened };
}

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('remote server', () => {
  it('serves the phone page with a strict CSP, 404s anything else', async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Dial TV Remote');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await fetch(`${base}/secrets.json`)).status).toBe(404);
    expect(srv!.status()).toMatchObject({ on: true, url: `${base}/`, code: expect.stringMatching(/^\d{6}$/) });
  });

  it('pairs with the code, then a WebSocket client with the token can control and receives now-playing', async () => {
    const { port, base, commands, stored } = await startServer();
    const code = srv!.status().code;
    const res = await pair(base, code);
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect(token).toBeTypeOf('string');
    expect(JSON.stringify(stored())).not.toContain(token); // only the hash is persisted
    expect(srv!.status().code).not.toBe(code); // single-use code

    srv!.publish({ channel: { number: '7', name: 'ESPN' }, title: 'Monday Night Football', favorites: [] });
    const c = openWs(port);
    await c.opened;
    c.ws.send(JSON.stringify({ t: token, type: 'hello' }));
    expect(await c.next('hello')).toMatchObject({ name: 'Test phone' });
    expect((await c.next('state')).state).toMatchObject({ channel: { name: 'ESPN' }, title: 'Monday Night Football' });
    expect(srv!.status().devices[0]).toMatchObject({ name: 'Test phone', connected: true });

    c.ws.send(JSON.stringify({ t: token, type: 'cmd', cmd: { type: 'chup' } }));
    c.ws.send(JSON.stringify({ t: token, type: 'cmd', cmd: { type: 'number', value: '42' } }));
    c.ws.send(JSON.stringify({ t: token, type: 'cmd', cmd: { type: 'shell', value: 'rm -rf' } })); // dropped
    await until(() => commands.length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(commands).toEqual([{ cmd: { type: 'chup' }, from: 'Test phone' }, { cmd: { type: 'number', value: '42' }, from: 'Test phone' }]);

    // Pushes reach connected phones.
    srv!.publish({ channel: { number: '8', name: 'FOX' }, favorites: [] });
    expect((await c.next('state')).state).toMatchObject({ channel: { name: 'FOX' } });

    // Every message needs the token: one without it closes the connection.
    c.ws.send(JSON.stringify({ type: 'cmd', cmd: { type: 'mute' } }));
    await c.next('unauthorized');
    expect(await c.closed).toBe(4001);
    expect(commands).toHaveLength(2);
  });

  it('revoking a phone disconnects it and its token stops working', async () => {
    const { port, base, commands } = await startServer();
    const { token } = await (await pair(base, srv!.status().code)).json();
    const c = openWs(port);
    await c.opened;
    c.ws.send(JSON.stringify({ t: token, type: 'hello' }));
    await c.next('hello');
    const id = srv!.status().devices[0].id;
    expect(srv!.revoke(id)).toBe(true);
    await c.next('unauthorized');
    expect(await c.closed).toBe(4001);

    const c2 = openWs(port);
    await c2.opened;
    c2.ws.send(JSON.stringify({ t: token, type: 'cmd', cmd: { type: 'chup' } }));
    await c2.next('unauthorized');
    expect(commands).toHaveLength(0);
  });

  it('rate-limits wrong codes per address (HTTP 429), then rotates the code', async () => {
    const { base } = await startServer();
    const code = srv!.status().code;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < core.MAX_TRIES - 1; i++) expect((await pair(base, wrong)).status).toBe(403);
    const locked = await pair(base, wrong);
    expect(locked.status).toBe(429);
    expect((await locked.json()).retryAfterSec).toBeGreaterThan(0);
    expect((await pair(base, code)).status).toBe(429); // right code refused while locked out
  });

  it('refuses cross-origin pairing, foreign Host headers, and bad WebSocket origins', async () => {
    const { port, base } = await startServer();
    const evil = await fetch(`${base}/pair`, { method: 'POST', headers: { Origin: 'http://evil.example' }, body: JSON.stringify({ code: srv!.status().code }) });
    expect(evil.status).toBe(403);
    const raw = (req: string) => new Promise<string>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(req));
      let out = '';
      s.on('data', (d) => { out += d; });
      s.on('close', () => resolve(out));
      s.on('error', () => resolve(out));
      setTimeout(() => s.destroy(), 1000);
    });
    expect(await raw('GET / HTTP/1.1\r\nHost: rebind.example:1\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 403/);
    const key = crypto.randomBytes(16).toString('base64');
    expect(await raw(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://evil.example\r\n\r\n`)).toMatch(/^HTTP\/1\.1 403/);
  });

  it('completes the handshake with a raw-socket client using our own framing', async () => {
    const { port, base, commands } = await startServer();
    const { token } = await (await pair(base, srv!.status().code)).json();
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
    sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:${port}\r\n\r\n`);
    await until(() => buf.includes('\r\n\r\n'));
    const head = buf.subarray(0, buf.indexOf('\r\n\r\n')).toString();
    expect(head).toMatch(/^HTTP\/1\.1 101/);
    expect(head).toContain(`Sec-WebSocket-Accept: ${core.acceptKey(key)}`);
    buf = buf.subarray(buf.indexOf('\r\n\r\n') + 4);
    sock.write(core.encodeClientFrame(JSON.stringify({ t: token, type: 'cmd', cmd: { type: 'guide' } })));
    await until(() => commands.length === 1);
    expect(commands[0]).toMatchObject({ cmd: { type: 'guide' } });
    // Ping → pong
    sock.write(core.encodeClientFrame('p', 9));
    await until(() => buf.length >= 3);
    expect(buf[0]).toBe(0x8a);
    sock.destroy();
  });

  it('stops listening when stopped', async () => {
    const { base } = await startServer();
    await srv!.stop();
    expect(srv!.status().on).toBe(false);
    await expect(fetch(`${base}/`)).rejects.toThrow();
  });

  it('falls back to the next port when the default is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const taken = (blocker.address() as net.AddressInfo).port;
    try {
      srv = createRemoteServer({ html: '', ports: [taken, 0], host: '127.0.0.1', interfaces: LOOPBACK });
      const port = await srv.start();
      expect(port).not.toBe(taken);
      expect(port).toBeGreaterThan(0);
    } finally {
      blocker.close();
    }
  });
});

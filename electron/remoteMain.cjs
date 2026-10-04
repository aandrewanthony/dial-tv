// Remote Control glue for the Electron main process: settings file, IPC, and the server's
// lifecycle (off by default; stopped when turned off and when the app quits).
const fs = require('node:fs');
const path = require('node:path');
const { createRemoteServer } = require('./remote.cjs');

let ctx = null; // { app, ipcMain, isApp, window }
let server = null;
let lastError = null;
let starting = null;

const file = () => path.join(ctx.app.getPath('userData'), 'remote.json');
function readConf() {
  try {
    const c = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { enabled: c.enabled === true, devices: Array.isArray(c.devices) ? c.devices : [] };
  } catch { return { enabled: false, devices: [] }; }
}
function writeConf(patch) {
  const next = { ...readConf(), ...patch };
  try { fs.writeFileSync(file(), JSON.stringify(next), { mode: 0o600 }); } catch { /* read-only profile */ }
}

function status() {
  const conf = readConf();
  const s = server ? server.status() : { on: false, port: 0, url: null, urls: [], code: null, devices: conf.devices.map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen, connected: false })) };
  return { ...s, enabled: conf.enabled, error: lastError };
}
function pushStatus() {
  const w = ctx?.window();
  if (w && !w.isDestroyed()) w.webContents.send('dial:remote-status', status());
}

function page() {
  return fs.readFileSync(path.join(__dirname, 'remote-page.html'), 'utf8');
}

async function start() {
  if (server) return;
  if (starting) return starting;
  starting = (async () => {
    const s = createRemoteServer({
      html: page(),
      devices: readConf().devices,
      onDevices: (devices) => writeConf({ devices }),
      onChange: pushStatus,
      onCommand: (cmd, device) => {
        const w = ctx.window();
        if (w && !w.isDestroyed()) w.webContents.send('dial:remote-cmd', cmd, device.name);
      },
    });
    try {
      await s.start();
      server = s;
      lastError = null;
    } catch (e) {
      lastError = `Couldn't start the remote server (${e.code || e.message}).`;
    }
  })();
  try { await starting; } finally { starting = null; }
}

async function stop() {
  const s = server;
  server = null;
  if (s) await s.stop();
}

function init(c) {
  ctx = c;
  const { ipcMain, isApp } = c;
  ipcMain.handle('dial:remote-status', (e) => (isApp(e.sender.id) ? status() : null));
  ipcMain.handle('dial:remote-enable', async (e, on) => {
    if (!isApp(e.sender.id)) return null;
    writeConf({ enabled: on === true });
    if (on === true) await start(); else { await stop(); lastError = null; }
    return status();
  });
  ipcMain.handle('dial:remote-revoke', (e, id) => {
    if (!isApp(e.sender.id) || typeof id !== 'string') return null;
    if (server) server.revoke(id);
    else writeConf({ devices: readConf().devices.filter((d) => d.id !== id) });
    return status();
  });
  ipcMain.handle('dial:remote-new-code', (e) => {
    if (!isApp(e.sender.id)) return null;
    server?.rotate();
    return status();
  });
  ipcMain.on('dial:remote-state', (e, state) => {
    if (!isApp(e.sender.id) || !server) return;
    server.publish(sanitizeState(state));
  });
  if (readConf().enabled) void start();
}

const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const num = (v) => (typeof v === 'number' || typeof v === 'string' ? String(v).slice(0, 8) : undefined);

/** Live game for the phone's Game tab: score bug + up to 15 plays, plain strings only. */
function sanitizeGame(g) {
  if (!g || typeof g !== 'object') return undefined;
  const side = (t) => (t && typeof t === 'object'
    ? { abbr: str(t.abbr, 8) ?? '', name: str(t.name, 60) ?? '', score: num(t.score), color: typeof t.color === 'string' && /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : undefined, poss: t.poss === true }
    : null);
  const away = side(g.away);
  const home = side(g.home);
  if (!away || !home || typeof g.id !== 'string') return undefined;
  const plays = Array.isArray(g.plays)
    ? g.plays.slice(0, 15).filter((p) => p && typeof p.id === 'string' && typeof p.text === 'string')
      .map((p) => ({ id: p.id.slice(0, 40), text: p.text.slice(0, 400), when: str(p.when, 24), scoring: p.scoring === true, penalty: str(p.penalty, 160) }))
    : [];
  return {
    id: g.id.slice(0, 64), league: str(g.league, 8), away, home, status: str(g.status, 40) ?? '', situation: str(g.situation, 80),
    redZone: g.redZone === true, hidden: g.hidden === true, feed: g.feed === true, plays,
  };
}

/** Only the fields the phone shows, as plain strings/numbers. */
function sanitizeState(s) {
  if (!s || typeof s !== 'object') return null;
  const ch = s.channel && typeof s.channel === 'object' ? { number: num(s.channel.number), name: str(s.channel.name) } : null;
  const favorites = Array.isArray(s.favorites)
    ? s.favorites.slice(0, 200).filter((f) => f && typeof f.id === 'string').map((f) => ({ id: f.id.slice(0, 512), number: num(f.number), name: str(f.name) }))
    : [];
  return { channel: ch, currentId: str(s.currentId, 512), title: str(s.title), time: str(s.time, 40), next: str(s.next), guideOpen: s.guideOpen === true, favorites, game: sanitizeGame(s.game) };
}

const shutdown = () => stop();

module.exports = { init, shutdown, sanitizeState };

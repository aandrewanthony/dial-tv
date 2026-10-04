// DVR lab: runs electron/dvr.cjs outside Electron against a local live stream and checks that
//   1) a short recording produces a playable, seekable .mp4 with video + audio,
//   2) a connection dropped mid-recording restarts into a new part and the parts are joined,
//   3) the playback server serves the file with byte ranges and rejects a bad token,
//   4) a recording interrupted by a quit is kept as "partial" on the next start,
//   5) delete moves the file to the trash (stubbed) and removes the entry.
//   node tests/streamlab/dvr.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const dvr = require('../../electron/dvr.cjs');
const decoder = require('../../electron/decoder.cjs');
const ffmpeg = require('ffmpeg-static');
const media = path.resolve('tests/streamlab/media/h264_aac.ts');
if (!fs.existsSync(media)) throw new Error('Run the stream lab once to create tests/streamlab/media (h264_aac.ts missing)');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Live-ish source: sends the file at ~2x real time in a loop; /drop closes the connection after 3 s.
const bytes = fs.readFileSync(media);
const src = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  const drop = req.url.startsWith('/drop') && !src.dropped;
  if (drop) src.dropped = true;
  let off = 0;
  const started = Date.now();
  const t = setInterval(() => {
    if (drop && Date.now() - started > 3000) { clearInterval(t); return res.destroy(); }
    const chunk = bytes.subarray(off, off + 188 * 400);
    off = (off + chunk.length) % bytes.length;
    if (!res.write(chunk)) { /* fine for a test */ }
  }, 50);
  req.on('close', () => clearInterval(t));
});
await new Promise((r) => src.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${src.address().port}`;

function makeApp(dir) {
  const app = new EventEmitter();
  app.getPath = (n) => (n === 'userData' ? dir : path.join(dir, 'videos'));
  return app;
}
const ipc = () => {
  const h = new Map();
  return { handle: (n, fn) => h.set(n, fn), call: (n, ...a) => h.get(n)({ sender: { id: 1 } }, ...a) };
};
const trashed = [];
function boot(dir) {
  const app = makeApp(dir);
  const ipcMain = ipc();
  dvr.create({
    app, ipcMain,
    shell: { trashItem: async (f) => { trashed.push(f); fs.rmSync(f, { force: true }); }, showItemInFolder() {}, openPath() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    dialog: {},
    ffmpegBin: ffmpeg, inputArgs: decoder.inputArgs, redactText: decoder.redactText,
    isAppSender: () => true, notify: () => {},
  });
  return { app, ipcMain };
}
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300); } return null; };
const probe = (f) => spawnSync(ffmpeg, ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr;
const durationOf = (txt) => { const m = /Duration: (\d+):(\d\d):(\d\d\.\d+)/.exec(txt); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dial-dvr-'));
try {
  // 1) + 3)
  let { app, ipcMain } = boot(dir);
  const now = Date.now();
  const r1 = await ipcMain.call('dvr:schedule', { channelId: 'c1', channelName: 'Lab', title: 'Short show', url: `${base}/live.ts`, start: now, end: now + 8000 });
  ok(r1.id && !r1.error, `schedule accepted (${r1.error ?? r1.id})`);
  const done1 = await until(async () => (await ipcMain.call('dvr:list')).recordings.find((r) => r.id === r1.id && (r.status === 'done' || r.status === 'failed')), 40_000);
  ok(done1?.status === 'done', `recording finished: ${done1?.status} ${done1?.error ?? ''}`);
  ok(done1?.file?.endsWith('.mp4'), `joined into mp4: ${done1?.file && path.basename(done1.file)}`);
  const info1 = done1?.file ? probe(done1.file) : '';
  ok(/Video: h264/.test(info1) && /Audio: aac/.test(info1), 'mp4 has h264 video + aac audio');
  const d1 = durationOf(info1);
  ok(d1 > 5 && d1 < 12, `duration about 8 s (${d1.toFixed(1)} s)`);
  ok(!JSON.stringify(await ipcMain.call('dvr:list')).includes(base), 'stream link never reaches the renderer');

  await sleep(300);
  const url = await ipcMain.call('dvr:play-url', r1.id);
  const head = await fetch(url, { headers: { Range: 'bytes=0-99' } });
  ok(head.status === 206 && (await head.arrayBuffer()).byteLength === 100, 'playback server serves byte ranges');
  ok((await fetch(url.replace(/t=\w+/, 't=bad'))).status === 403, 'bad token rejected');
  ok((await fetch(url.replace(/\/rec\/\w+/, '/rec/0000000000000000'))).status === 404, 'unknown recording is 404');

  // 2) dropped connection
  const t2 = Date.now();
  const r2 = await ipcMain.call('dvr:schedule', { channelId: 'c2', channelName: 'Lab', title: 'Dropped show', url: `${base}/drop.ts`, start: t2, end: t2 + 14000 });
  const done2 = await until(async () => (await ipcMain.call('dvr:list')).recordings.find((r) => r.id === r2.id && (r.status === 'done' || r.status === 'failed')), 60_000);
  ok(done2?.status === 'done' && done2.file?.endsWith('.mp4'), `dropped stream restarted and joined: ${done2?.status} ${done2?.error ?? ''}`);
  const d2 = durationOf(done2?.file ? probe(done2.file) : '');
  ok(d2 > 6, `joined recording has both parts (${d2.toFixed(1)} s)`);

  // 5) delete → trash
  ok(await ipcMain.call('dvr:remove', r1.id), 'remove ok');
  ok(trashed.some((f) => f === done1.file) && !fs.existsSync(done1.file), 'file moved to trash');

  // 4) quit mid-recording, restart
  const t3 = Date.now();
  const r3 = await ipcMain.call('dvr:schedule', { channelId: 'c3', channelName: 'Lab', title: 'Interrupted', url: `${base}/live.ts`, start: t3, end: t3 + 60_000 });
  await until(async () => (await ipcMain.call('dvr:list')).recordings.find((r) => r.id === r3.id && r.status === 'recording'), 10_000);
  await sleep(4000);
  app.emit('before-quit');
  await sleep(800);
  ({ app, ipcMain } = boot(dir));
  const after = (await ipcMain.call('dvr:list')).recordings.find((r) => r.id === r3.id);
  ok(after?.status === 'done' && after.partial && fs.existsSync(after.file), `interrupted recording kept as partial (${after?.status})`);
  app.emit('before-quit');

  // validation
  ok(typeof dvr.validateJob({ url: 'file:///etc/passwd', start: 1, end: Date.now() + 1e5 }) === 'string', 'file: links rejected');
  ok(typeof dvr.validateJob({ url: 'http://x/y', start: Date.now(), end: Date.now() + 9 * 3600_000 }) === 'string', 'over 8 hours rejected');
} finally {
  src.close();
  await sleep(500);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* files may still be closing */ }
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

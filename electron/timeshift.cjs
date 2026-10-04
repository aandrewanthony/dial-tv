// Pause & rewind live TV (Settings → Playback, off by default).
//
// One ffmpeg process stream-copies the live channel (video + audio, no re-encoding) into a rolling
// HLS playlist in a temp folder: ~4 s segments, a 30-minute window, older segments deleted. The
// player plays that local playlist with hls.js, so pausing keeps recording and the viewer can seek
// anywhere in the window. The provider still sees a single connection (ffmpeg's).
//
//  - one session at a time: starting a new one (channel change) stops the old one and deletes its files;
//  - files are served by a token-protected 127.0.0.1 server that only serves the current session's
//    playlist and segments;
//  - every session folder is named after this process (pid); folders left by a crashed run are
//    removed on the next start, and the current one on quit;
//  - a dropped input restarts ffmpeg a few times, appending to the same playlist (discontinuity).
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const SEGMENT_SECS = 4;
const WINDOW_SECS = 30 * 60;
const LIST_SIZE = Math.ceil(WINDOW_SECS / SEGMENT_SECS); // 450 segments
const READY_TIMEOUT_MS = 15_000;
const MIN_FREE = 3 * 1024 ** 3; // a 30-minute window of a high-bitrate channel is ~1–2 GB
const MAX_RESTARTS = 5;
const PLAYLIST = 'index.m3u8';
const SEGMENT_RE = /^seg\d{1,9}\.ts$/;

/** ffmpeg arguments: copy the first video + audio track into a rolling HLS playlist (cwd = session folder). */
function timeshiftArgs(inputArgs, url, headers, { append = false } = {}) {
  const a = inputArgs(url, headers, 'info'); // 'info' prints the input's codecs (parsed for the player)
  a.splice(1, 0, '-nostats');
  a.push(
    '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-sn', '-dn',
    '-f', 'hls', '-hls_time', String(SEGMENT_SECS), '-hls_list_size', String(LIST_SIZE),
    '-hls_flags', `delete_segments+temp_file+independent_segments+omit_endlist${append ? '+append_list+discont_start' : ''}`,
    '-hls_delete_threshold', '2',
    '-hls_segment_filename', 'seg%d.ts',
    PLAYLIST,
  );
  return a;
}

/** Number of segments in a playlist text. */
const segmentCount = (text) => (String(text).match(/^#EXTINF/gm) ?? []).length;

/** Is a process with this pid still running? */
function alive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

function create({ app, ipcMain, ffmpegBin, inputArgs, normalizeSource, parseProbe, redactText, isAppSender }) {
  const available = !!ffmpegBin && fs.existsSync(ffmpegBin);
  const root = path.join(app.getPath('temp'), 'dial-tv-timeshift');
  const TOKEN = crypto.randomBytes(16).toString('hex');
  let port = 0;
  /** @type {null | { id: string, dir: string, proc: any, restarts: number, stopped: boolean, info: any, url: string, headers: any }} */
  let current = null;
  const stoppedIds = new Set(); // stop() that arrived while its start() was still checking the disk
  const owned = new Set(); // sessions whose folder still exists (deleted on quit at the latest)

  const rmDir = (dir) => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});

  // Folders from runs that are gone (crash, kill): delete. Other running copies (test profiles) keep theirs.
  try {
    for (const name of fs.readdirSync(root)) {
      const pid = Number(/^(\d+)-/.exec(name)?.[1]);
      if (!alive(pid) || pid === process.pid) void rmDir(path.join(root, name));
    }
  } catch { /* no folder yet */ }

  const cleanup = (s) => rmDir(s.dir).then(() => { if (!fs.existsSync(s.dir)) owned.delete(s); });

  async function freeBytes(dir) {
    try { const s = await fs.promises.statfs(dir); return s.bavail * s.bsize; } catch { return Infinity; }
  }

  function stopSession(s) {
    if (!s || s.stopped) return;
    s.stopped = true;
    if (current === s) current = null;
    s.resolveReady?.({ error: 'stopped' });
    const proc = s.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.once('close', () => void cleanup(s));
      proc.kill('SIGKILL');
    } else void cleanup(s);
  }

  function spawnFfmpeg(s, append) {
    let proc;
    try {
      proc = spawn(ffmpegBin, timeshiftArgs(inputArgs, s.url, s.headers, { append }), { cwd: s.dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      s.resolveReady?.({ error: `Could not start ffmpeg (${e?.code || e?.message})` });
      return;
    }
    s.proc = proc;
    let head = ''; // the input description (codecs) is near the start
    let tail = '';
    const startedAt = Date.now();
    proc.stderr.on('data', (d) => {
      const t = String(d);
      if (head.length < 30000) head += t;
      tail = (tail + t).slice(-3000);
      if (!s.info) {
        const info = /Output #0|Stream mapping/.test(head) ? parseProbe(head) : null;
        if (info) {
          s.info = info;
          // A file with a length (movie, recording) would be copied as fast as the network allows: not live.
          if (info.duration) s.resolveReady?.({ error: 'not live' });
        }
      }
    });
    proc.on('error', () => { /* 'close' follows */ });
    proc.on('close', (code) => {
      if (s.proc === proc) s.proc = null;
      if (s.stopped) return;
      const why = redactText(tail.trim().split('\n').slice(-2).join(' | '));
      if (s.resolveReady) {
        // Never got going: let the player fall back to its normal path.
        s.resolveReady({ error: `ffmpeg ended before the first segments (code ${code}): ${why}` });
        return stopSession(s);
      }
      if (s.restarts < MAX_RESTARTS) {
        s.restarts++;
        const quick = Date.now() - startedAt < 10_000;
        console.error(`[timeshift] input ended (code ${code}), restart ${s.restarts}:`, why);
        setTimeout(() => { if (!s.stopped) spawnFfmpeg(s, true); }, quick ? 2000 * s.restarts : 500);
        return;
      }
      console.error('[timeshift] input kept dropping, giving up:', why);
      // Leave the files: what is buffered can still be watched; the player's watchdog notices the end.
    });
  }

  /** Start a session; resolves once the first segment is on disk (or with { error }). */
  async function start(id, rawUrl, headers) {
    if (!available) return { error: 'ffmpeg not available' };
    if (typeof id !== 'string' || !/^[a-z0-9]{8,32}$/.test(id)) return { error: 'bad id' };
    const src = normalizeSource(rawUrl);
    if (!src || !/^https?:\/\//i.test(src)) return { error: 'unsupported link' };
    stopSession(current);
    fs.mkdirSync(root, { recursive: true });
    if (await freeBytes(root) < MIN_FREE) return { error: 'not enough free disk space' };
    if (stoppedIds.delete(id)) return { error: 'stopped' };
    const dir = path.join(root, `${process.pid}-${id}`);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { error: `temp folder: ${e?.code}` }; }
    const s = { id, dir, proc: null, restarts: 0, stopped: false, info: null, url: src, headers: headers && typeof headers === 'object' ? headers : {} };
    if (current) stopSession(current); // another start raced in while we checked the disk
    current = s;
    owned.add(s);
    const ready = new Promise((resolve) => { s.resolveReady = (r) => { if (s.resolveReady) { s.resolveReady = null; resolve(r); } }; });
    spawnFfmpeg(s, false);
    // Ready with two segments (one plays while the next is written, so no stall right after the
    // start); channels with very long keyframe intervals start with one when the time is up.
    const started = Date.now();
    const poll = setInterval(async () => {
      if (!s.resolveReady) return;
      let n = 0;
      try { n = segmentCount(await fs.promises.readFile(path.join(dir, PLAYLIST), 'utf8')); } catch { /* not written yet */ }
      const late = Date.now() - started >= READY_TIMEOUT_MS;
      if (n >= 2 || (late && n >= 1)) s.resolveReady?.({ ok: true });
      else if (late) s.resolveReady?.({ error: 'timeout waiting for the first segments' });
    }, 250);
    const r = await ready;
    clearInterval(poll);
    if (r.error) {
      if (r.error !== 'stopped') console.error('[timeshift] not used:', r.error);
      stopSession(s);
      return { error: r.error, info: s.info };
    }
    return {
      url: `http://127.0.0.1:${port}/ts/${TOKEN}/${id}/${PLAYLIST}`,
      info: s.info,
      windowSecs: WINDOW_SECS,
    };
  }

  // ---------------------------------------------------------------- local server (current session only)
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  const server = http.createServer(async (req, res) => {
    const m = /^\/ts\/([a-f0-9]{32})\/([a-z0-9]{8,32})\/([^/]+)$/.exec(new URL(req.url, 'http://127.0.0.1').pathname);
    if (!m || m[1] !== TOKEN || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(403); return res.end(); }
    const s = current;
    const name = m[3];
    if (!s || s.id !== m[2] || (name !== PLAYLIST && !SEGMENT_RE.test(name))) { res.writeHead(404, cors); return res.end(); }
    const file = path.join(s.dir, name);
    if (name === PLAYLIST) {
      let text;
      try { text = await fs.promises.readFile(file); } catch { res.writeHead(404, cors); return res.end(); }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': text.length });
      return res.end(req.method === 'HEAD' ? undefined : text);
    }
    let size;
    try { size = (await fs.promises.stat(file)).size; } catch { res.writeHead(404, cors); return res.end(); }
    res.writeHead(200, { ...cors, 'Content-Type': 'video/mp2t', 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
  server.listen(0, '127.0.0.1', () => { port = server.address().port; });

  // ---------------------------------------------------------------- IPC
  const guard = (fn) => (e, ...args) => (isAppSender(e) ? fn(...args) : null);
  ipcMain.handle('timeshift:start', guard((id, url, headers) => start(id, url, headers)));
  ipcMain.handle('timeshift:stop', guard((id) => {
    if (current && current.id === id) stopSession(current);
    else { stoppedIds.add(id); if (stoppedIds.size > 50) stoppedIds.delete(stoppedIds.values().next().value); }
    return true;
  }));

  app.on('before-quit', () => {
    // Every folder this run made (the current session and any still being deleted): stop ffmpeg and
    // delete synchronously, since the app is about to exit. A killed process can hold its files for
    // a moment (Windows), so retry briefly; anything left is removed on the next start.
    current = null;
    for (const s of owned) {
      s.stopped = true;
      try { if (s.proc && s.proc.exitCode === null) s.proc.kill('SIGKILL'); } catch { /* gone */ }
    }
    const nap = new Int32Array(new SharedArrayBuffer(4));
    const until = Date.now() + 3000;
    for (const s of owned) {
      for (;;) {
        try { fs.rmSync(s.dir, { recursive: true, force: true }); break; } catch (e) {
          if (Date.now() > until) { console.error('[timeshift] could not delete the buffer on quit:', e?.code); break; }
          Atomics.wait(nap, 0, 0, 100);
        }
      }
    }
    owned.clear();
  });
  app.on('will-quit', () => server.close());

  return { stop: () => stopSession(current) };
}

module.exports = { create, timeshiftArgs, segmentCount, SEGMENT_SECS, WINDOW_SECS, LIST_SIZE };

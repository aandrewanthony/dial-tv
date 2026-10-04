// DVR: records live channels to disk with the bundled ffmpeg (stream copy, no re-encoding).
//
// Built to fail safe and stay out of the way of playback:
//  - each recording is its own ffmpeg process copying the stream into MPEG-TS parts (a killed or
//    crashed recording still leaves a playable file); when it ends the parts are joined into one .mp4
//    (seekable in the player); if that fails the .ts is kept;
//  - a dropped connection restarts into a new part, a few times, until the end time;
//  - guard rails: max simultaneous recordings, max length, free-space check before and during;
//  - schedules live in userData/dvr.json (stream links encrypted with the OS keychain when available)
//    and are checked every 15 s; anything that was recording when the app quit or crashed is finalized
//    as "partial" on the next start;
//  - deleting a recording moves its file to the Recycle Bin / Trash;
//  - recordings are played from a token-protected 127.0.0.1 server that only serves files this
//    module recorded.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const TICK_MS = 15_000;
const MAX_HOURS = 8;
const MIN_FREE_START = 2 * 1024 ** 3; // don't start below 2 GB free
const MIN_FREE_KEEP = 1 * 1024 ** 3; // stop below 1 GB free
const MAX_RESTARTS = 6;
const KEEP_FINISHED = 500;
const MAX_EXTEND_MS = 90 * 60_000; // a running game can push its recording's end out this far

const DEFAULT_SETTINGS = { folder: '', maxConcurrent: 2, padBefore: 1, padAfter: 3 };

/** Safe file name part from a title. */
function slug(s) {
  return String(s || 'Recording').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Recording';
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Validate a recording request from the renderer. Returns a clean job or an error string. */
function validateJob(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return 'Bad request';
  const url = String(raw.url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url) && !/^(rtmps?|rtsp|udp|rtp|srt|mmsh?):\/\/\S+$/i.test(url)) return 'This channel can’t be recorded';
  const start = Number(raw.start), end = Number(raw.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'Bad times';
  if (end <= now) return 'That show already ended';
  if (end - Math.max(start, now) > MAX_HOURS * 3600_000) return `Recordings are limited to ${MAX_HOURS} hours`;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const headers = {};
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [k, v] of Object.entries(raw.headers).slice(0, 32)) if (typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(k)) headers[k] = v.replace(/[\r\n\0]+/g, ' ').slice(0, 4096);
  }
  return {
    channelId: str(raw.channelId, 300) ?? '',
    channelName: str(raw.channelName, 200) ?? 'Channel',
    title: str(raw.title, 200) || str(raw.channelName, 200) || 'Recording',
    subtitle: str(raw.subtitle, 300),
    programId: str(raw.programId, 300),
    // Made by a renderer recording rule (auto-record my teams / series): shown as "Auto: …".
    rule: raw.rule && typeof raw.rule === 'object' && typeof raw.rule.id === 'string'
      ? { id: raw.rule.id.slice(0, 100), label: str(raw.rule.label, 100) ?? '', key: str(raw.rule.key, 400) ?? '' }
      : undefined,
    start, end, url, headers,
  };
}

/** Recordings that would run at the same time as [start, end) — for conflict warnings. */
function overlapping(list, start, end, exceptId) {
  return list.filter((r) => r.id !== exceptId && (r.status === 'scheduled' || r.status === 'recording') && r.start < end && r.end > start);
}

/** ffmpeg arguments: copy video + audio into MPEG-TS for `seconds`. */
function recordArgs(inputArgs, url, headers, seconds, file) {
  return [
    ...inputArgs(url, headers, 'error'),
    '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-dn', '-sn',
    '-t', String(Math.max(1, Math.round(seconds))),
    '-f', 'mpegts', '-y', file,
  ];
}

/** ffmpeg arguments to join parts into a seekable .mp4 (the mp4 muxer converts ADTS AAC itself). */
function remuxArgs(listFile, out) {
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', '-y', out];
}

function create({ app, ipcMain, shell, safeStorage, dialog, ffmpegBin, inputArgs, redactText, isAppSender, notify }) {
  const stateFile = path.join(app.getPath('userData'), 'dvr.json');
  const available = !!ffmpegBin && fs.existsSync(ffmpegBin);
  const TOKEN = crypto.randomBytes(16).toString('hex');
  let port = 0;
  let state = { settings: { ...DEFAULT_SETTINGS }, recordings: [] };
  const running = new Map(); // id → { proc, parts: string[], restarts, stopping }
  const listeners = new Set();

  // ---------------------------------------------------------------- persistence
  const enc = (s) => {
    try { if (safeStorage.isEncryptionAvailable()) return { e: safeStorage.encryptString(s).toString('base64') }; } catch { /* fall through */ }
    return { p: s };
  };
  const dec = (v) => {
    if (!v) return '';
    if (v.p != null) return v.p;
    try { return safeStorage.decryptString(Buffer.from(v.e, 'base64')); } catch { return ''; }
  };
  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state = { settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }, recordings: Array.isArray(raw.recordings) ? raw.recordings : [] };
    } catch { /* first run */ }
  }
  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    try {
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch (e) { console.error('[dvr] save failed:', e?.code || e?.message); }
  }
  const folder = () => state.settings.folder || path.join(app.getPath('videos'), 'Dial TV Recordings');

  /** What the renderer sees: no stream links or headers. */
  const publicRec = (r) => {
    const { secret, ...rest } = r; // eslint-disable-line no-unused-vars
    return { ...rest, live: running.has(r.id) };
  };
  const snapshot = () => ({
    available,
    settings: { ...state.settings, folder: folder() },
    recordings: state.recordings.map(publicRec),
  });
  function changed() {
    save();
    const snap = snapshot();
    for (const fn of listeners) { try { fn(snap); } catch { /* window gone */ } }
  }

  async function freeBytes(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const s = await fs.promises.statfs(dir);
      return s.bavail * s.bsize;
    } catch { return Infinity; } // unknown: don't block
  }

  // ---------------------------------------------------------------- recording
  async function begin(r) {
    if (running.has(r.id)) return;
    const dir = folder();
    if (await freeBytes(dir) < MIN_FREE_START) return fail(r, 'Not enough free disk space (need 2 GB)');
    const base = path.join(dir, `${slug(r.title)} - ${stamp(r.start)} - ${slug(r.channelName)}`);
    r.base = base;
    r.status = 'recording';
    r.startedAt = r.startedAt ?? Date.now();
    r.parts = r.parts ?? [];
    running.set(r.id, { proc: null, restarts: 0, stopping: false });
    changed();
    notify?.(`Recording ${r.title}`, r.channelName);
    spawnPart(r);
  }

  function spawnPart(r) {
    const job = running.get(r.id);
    if (!job || job.stopping) return;
    const secs = (r.end - Date.now()) / 1000;
    if (secs < 2) return finish(r);
    const { url, headers } = JSON.parse(dec(r.secret) || '{}');
    if (!url) return fail(r, 'Stream link missing');
    const file = `${r.base}${r.parts.length ? `.part${r.parts.length + 1}` : ''}.ts`;
    r.parts.push(file);
    job.partEnd = r.end; // -t ends this part here; a later dvr:extend continues into a new part
    let proc;
    try {
      proc = spawn(ffmpegBin, recordArgs(inputArgs, url, headers, secs, file), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return fail(r, `Could not start recorder (${e?.code || e?.message})`);
    }
    job.proc = proc;
    let stderr = '';
    const startedAt = Date.now();
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-3000); });
    proc.on('error', () => { /* 'close' follows */ });
    proc.on('close', (code) => {
      if (job.proc === proc) job.proc = null;
      if (job.stopping) return;
      const left = r.end - Date.now();
      if (left > 5000 && Date.now() >= job.partEnd - 5000) {
        // Ran to its planned end, but the end was pushed later (a game ran long): keep going.
        spawnPart(r);
        return;
      }
      if (left > 5000 && job.restarts < MAX_RESTARTS) {
        // Dropped early: try again into a new part (back off if it fails right away).
        job.restarts++;
        const quick = Date.now() - startedAt < 10_000;
        console.error(`[dvr] ${r.id} input ended (code ${code}), restart ${job.restarts}:`, redactText(stderr.trim().split('\n').slice(-2).join(' | ')));
        setTimeout(() => spawnPart(r), quick ? 5000 * job.restarts : 1000);
        return;
      }
      if (left > 5000) r.error = 'Stream kept dropping; recorded what came through';
      finish(r);
    });
  }

  function stop(r, reason) {
    const job = running.get(r.id);
    if (!job) return;
    job.stopping = true;
    if (reason) r.error = reason;
    if (job.proc && job.proc.exitCode === null) {
      // MPEG-TS needs no trailer, so a hard stop still leaves a playable file.
      job.proc.once('close', () => finish(r));
      job.proc.kill('SIGKILL');
    } else finish(r);
  }

  function fail(r, msg) {
    running.delete(r.id);
    r.status = 'failed';
    r.error = msg;
    changed();
    notify?.(`Recording failed: ${r.title}`, msg);
  }

  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

  async function finish(r) {
    running.delete(r.id);
    const parts = (r.parts ?? []).filter((f) => sizeOf(f) > 0);
    if (!parts.length) return fail(r, r.error || 'Nothing was recorded (the stream didn’t start)');
    r.status = 'processing';
    r.endedAt = Date.now();
    changed();
    const mp4 = `${r.base}.mp4`;
    const ok = await remux(parts, mp4);
    if (ok) {
      for (const f of parts) fs.promises.unlink(f).catch(() => {});
      r.file = mp4;
    } else {
      // Keep the recording as MPEG-TS (still plays; the player converts it if needed).
      r.file = parts[0];
      if (parts.length > 1) r.extraFiles = parts.slice(1);
    }
    r.bytes = sizeOf(r.file) + (r.extraFiles ?? []).reduce((n, f) => n + sizeOf(f), 0);
    r.status = 'done';
    delete r.secret; // the stream link isn't needed any more
    changed();
    notify?.(`Recorded ${r.title}`, r.channelName);
  }

  function remux(parts, out) {
    return new Promise((resolve) => {
      const list = `${out}.txt`;
      try {
        fs.writeFileSync(list, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
      } catch { return resolve(false); }
      let p;
      try { p = spawn(ffmpegBin, remuxArgs(list, out), { windowsHide: true, stdio: 'ignore' }); } catch { return resolve(false); }
      const t = setTimeout(() => p.kill('SIGKILL'), 10 * 60_000);
      p.on('error', () => {});
      p.on('close', (code) => {
        clearTimeout(t);
        fs.promises.unlink(list).catch(() => {});
        const good = code === 0 && sizeOf(out) > 0;
        if (!good) fs.promises.unlink(out).catch(() => {});
        resolve(good);
      });
    });
  }

  // ---------------------------------------------------------------- scheduler
  let lastSpaceCheck = 0;
  async function tick() {
    const now = Date.now();
    for (const r of state.recordings) {
      if (r.status === 'scheduled') {
        if (r.end <= now) { r.status = 'missed'; r.error = 'Dial TV wasn’t running'; changed(); continue; }
        if (r.start <= now + 1000) {
          if (running.size >= state.settings.maxConcurrent) {
            if (!r.waiting) { r.waiting = true; r.error = `Waiting: ${state.settings.maxConcurrent} recordings already running`; changed(); }
            continue;
          }
          delete r.waiting;
          delete r.error;
          await begin(r);
        }
      } else if (r.status === 'recording' && running.has(r.id) && r.end <= now - 3000) {
        stop(r); // -t should have ended it already; this is the backstop
      }
    }
    if (running.size && now - lastSpaceCheck > 60_000) {
      lastSpaceCheck = now;
      if (await freeBytes(folder()) < MIN_FREE_KEEP) {
        for (const r of state.recordings) if (running.has(r.id)) stop(r, 'Stopped: disk almost full');
      }
    }
  }

  // ---------------------------------------------------------------- playback server
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const m = /^\/rec\/([a-f0-9]{16})(?:\.\w+)?$/.exec(u.pathname);
    if (!m || u.searchParams.get('t') !== TOKEN || req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(403); return res.end(); }
    const r = state.recordings.find((x) => x.id === m[1]);
    const file = r?.file;
    let size;
    try { size = fs.statSync(file).size; } catch { res.writeHead(404); return res.end(); }
    const type = file.endsWith('.mp4') ? 'video/mp4' : 'video/mp2t';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (range && (range[1] || range[2])) {
      let start = range[1] ? +range[1] : size - +range[2];
      let end = range[1] && range[2] ? +range[2] : size - 1;
      start = Math.max(0, start); end = Math.min(size - 1, end);
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...base, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });

  // ---------------------------------------------------------------- IPC
  const guard = (fn) => (e, ...args) => (isAppSender(e) ? fn(...args) : null);
  const byId = (id) => state.recordings.find((r) => r.id === id);

  ipcMain.handle('dvr:list', guard(() => snapshot()));
  ipcMain.handle('dvr:schedule', guard((raw) => {
    if (!available) return { error: 'Recording needs the built-in decoder (ffmpeg), which isn’t available' };
    const job = validateJob(raw);
    if (typeof job === 'string') return { error: job };
    // Same programme on the same channel already scheduled: don't double up. (Padding makes
    // back-to-back shows touch, so a small overlap is a different show.)
    const dupe = state.recordings.find((r) => (r.status === 'scheduled' || r.status === 'recording') && r.channelId === job.channelId
      && ((job.programId && r.programId === job.programId) || Math.min(r.end, job.end) - Math.max(r.start, job.start) > (job.end - job.start) / 2));
    if (dupe) return { error: 'Already recording this', id: dupe.id };
    const { url, headers, ...meta } = job;
    const r = { id: crypto.randomBytes(8).toString('hex'), ...meta, status: 'scheduled', createdAt: Date.now(), secret: enc(JSON.stringify({ url, headers })) };
    state.recordings.push(r);
    const conflicts = overlapping(state.recordings, r.start, r.end, r.id).length + 1 > state.settings.maxConcurrent;
    changed();
    void tick();
    return { id: r.id, conflicts };
  }));
  ipcMain.handle('dvr:stop', guard((id) => {
    const r = byId(id);
    if (!r) return false;
    if (r.status === 'scheduled') { r.status = 'cancelled'; delete r.secret; changed(); return true; }
    if (r.status === 'recording') { r.end = Math.min(r.end, Date.now()); stop(r); return true; }
    return false;
  }));
  // Push a recording's end later (a game running long). Capped at +90 min over the original end
  // and the overall length limit; never shortens.
  ipcMain.handle('dvr:extend', guard((id, end) => {
    const r = byId(id);
    end = Number(end);
    if (!r || (r.status !== 'recording' && r.status !== 'scheduled') || !Number.isFinite(end)) return false;
    r.origEnd = r.origEnd ?? r.end;
    const next = Math.min(end, r.origEnd + MAX_EXTEND_MS, r.start + MAX_HOURS * 3600_000);
    if (next <= r.end) return false;
    r.end = next;
    changed();
    return true;
  }));
  ipcMain.handle('dvr:remove', guard(async (id) => {
    const r = byId(id);
    if (!r || r.status === 'recording' || r.status === 'processing') return false;
    for (const f of [r.file, ...(r.extraFiles ?? [])].filter(Boolean)) {
      try { await shell.trashItem(f); } catch { /* already gone */ }
    }
    state.recordings = state.recordings.filter((x) => x !== r);
    changed();
    return true;
  }));
  ipcMain.handle('dvr:play-url', guard((id) => {
    const r = byId(id);
    if (!r?.file || !port) return null;
    return `http://127.0.0.1:${port}/rec/${r.id}${r.file.endsWith('.mp4') ? '.mp4' : '.ts'}?t=${TOKEN}`;
  }));
  ipcMain.handle('dvr:reveal', guard((id) => {
    const r = id ? byId(id) : null;
    if (r?.file && fs.existsSync(r.file)) shell.showItemInFolder(r.file);
    else { fs.mkdirSync(folder(), { recursive: true }); shell.openPath(folder()); }
    return true;
  }));
  ipcMain.handle('dvr:settings', guard((patch) => {
    if (patch && typeof patch === 'object') {
      const s = state.settings;
      if (Number.isInteger(patch.maxConcurrent)) s.maxConcurrent = Math.max(1, Math.min(4, patch.maxConcurrent));
      if (Number.isFinite(patch.padBefore)) s.padBefore = Math.max(0, Math.min(15, Math.round(patch.padBefore)));
      if (Number.isFinite(patch.padAfter)) s.padAfter = Math.max(0, Math.min(60, Math.round(patch.padAfter)));
      changed();
    }
    return snapshot().settings;
  }));
  ipcMain.handle('dvr:choose-folder', guard(async () => {
    const r = await dialog.showOpenDialog({ title: 'Folder for recordings', defaultPath: folder(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    state.settings.folder = r.filePaths[0];
    changed();
    return state.settings.folder;
  }));

  // ---------------------------------------------------------------- lifecycle
  load();
  // Interrupted by a quit or crash: what was recorded is kept.
  for (const r of state.recordings) {
    if (r.status === 'recording' || r.status === 'processing') {
      const parts = (r.parts ?? []).filter((f) => sizeOf(f) > 0);
      if (parts.length) { r.status = 'done'; r.partial = true; r.file = parts[0]; r.extraFiles = parts.slice(1); r.bytes = parts.reduce((n, f) => n + sizeOf(f), 0); r.error = 'Dial TV closed during the recording'; }
      else { r.status = 'failed'; r.error = 'Dial TV closed before anything was recorded'; }
      delete r.secret;
    }
    delete r.waiting;
  }
  // Keep the list bounded (oldest finished entries without files go first).
  const finished = state.recordings.filter((r) => !['scheduled', 'recording'].includes(r.status));
  if (finished.length > KEEP_FINISHED) {
    const drop = new Set(finished.filter((r) => r.status !== 'done').slice(0, finished.length - KEEP_FINISHED));
    state.recordings = state.recordings.filter((r) => !drop.has(r));
  }
  saveNow();
  server.listen(0, '127.0.0.1', () => { port = server.address().port; });
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => void tick(), 2000);

  app.on('before-quit', () => {
    clearInterval(timer);
    for (const [, job] of running) { job.stopping = true; if (job.proc && job.proc.exitCode === null) job.proc.kill('SIGKILL'); }
    // Marked as recording on disk: the next start finalizes them as partial.
    saveNow();
    server.close();
  });

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

module.exports = { create, MAX_EXTEND_MS, validateJob, overlapping, recordArgs, remuxArgs, slug, stamp, DEFAULT_SETTINGS, MAX_HOURS };

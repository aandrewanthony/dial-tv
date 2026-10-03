// Built-in decoder: converts streams Chromium can't play (MPEG-2 video, AC-3/E-AC-3/MP2 audio,
// HEVC on machines without HEVC support) into H.264 + AAC MPEG-TS on the fly with ffmpeg,
// served to the player from a token-protected server on 127.0.0.1.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const TOKEN = crypto.randomBytes(16).toString('hex');
const MAX_SESSIONS = 6; // multiview (4) + headroom
const sessions = new Set();
let port = 0;

function ffmpegPath(app) {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg', exe);
  return require('ffmpeg-static');
}

const isHttp = (u) => /^https?:\/\//i.test(u);

function inputArgs(url, ua, referer) {
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (isHttp(url)) {
    a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5');
    a.push('-user_agent', ua || 'VLC/3.0.21 LibVLC/3.0.21');
    if (referer) a.push('-headers', `Referer: ${referer}\r\n`);
  }
  a.push('-fflags', '+genpts+discardcorrupt', '-i', url);
  return a;
}

/** Inspect a stream's codecs with ffmpeg (no output file → prints stream info and exits). */
function probe(bin, url, ua, referer, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const args = inputArgs(url, ua, referer).map((x) => (x === 'error' ? 'info' : x));
    args.splice(args.indexOf('-i'), 0, '-analyzeduration', '4000000', '-probesize', '4000000');
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) p.kill('SIGKILL'); });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      clearTimeout(timer);
      const v = /Stream #\d+:\d+[^:]*: Video: (\w+)([^\n]*)/.exec(err);
      const a = /Stream #\d+:\d+[^:]*: Audio: (\w+)([^\n]*)/.exec(err);
      if (!v && !a) return resolve(null);
      resolve({
        video: v?.[1] ?? null,
        audio: a?.[1] ?? null,
        interlaced: !!v && /top first|bottom first|\btff\b|\bbff\b|interlaced/i.test(v[2]),
        resolution: v ? (/(\d{3,4})x(\d{3,4})/.exec(v[2])?.slice(1, 3).join('x') ?? null) : null,
      });
    });
  });
}

/** ffmpeg args that turn any input into browser-playable H.264/AAC MPEG-TS. */
function transcodeArgs(url, ua, referer, info) {
  const a = inputArgs(url, ua, referer);
  a.push('-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn');
  if (info?.video === 'h264') {
    a.push('-c:v', 'copy');
  } else {
    if (info?.interlaced || info?.video === 'mpeg2video') a.push('-vf', 'yadif=0:-1:1');
    a.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '20', '-maxrate', '10M', '-bufsize', '20M',
      '-g', '60', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-profile:v', 'high');
  }
  a.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
  a.push('-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-flush_packets', '1', 'pipe:1');
  return a;
}

function start(app, ipcMain) {
  const bin = ffmpegPath(app);
  const available = fs.existsSync(bin);
  const probeCache = new Map();

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/stream' || u.searchParams.get('t') !== TOKEN) { res.writeHead(403); return res.end(); }
    const src = u.searchParams.get('u') ?? '';
    if (!isHttp(src)) { res.writeHead(400); return res.end(); }
    if (sessions.size >= MAX_SESSIONS) { res.writeHead(503); return res.end('too many decoders'); }
    const ua = u.searchParams.get('ua') ?? '';
    const ref = u.searchParams.get('ref') ?? '';
    const info = probeCache.get(src) ?? (await probe(bin, src, ua, ref));
    if (info) probeCache.set(src, info);
    const ff = spawn(bin, transcodeArgs(src, ua, ref, info), { windowsHide: true });
    sessions.add(ff);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    ff.stdout.pipe(res);
    const stop = () => { if (!ff.killed) ff.kill('SIGKILL'); };
    req.on('close', stop);
    res.on('close', stop);
    ff.on('close', (code) => {
      sessions.delete(ff);
      if (code && stderr) console.error('[decoder]', stderr.trim().split('\n').slice(-3).join(' | '));
      res.end();
    });
  });
  server.listen(0, '127.0.0.1', () => { port = server.address().port; });

  ipcMain.handle('dial:decoder-info', () => ({ available }));
  ipcMain.handle('dial:probe', async (_e, src, ua, ref) => {
    if (!available || !isHttp(String(src))) return null;
    if (probeCache.has(String(src))) return probeCache.get(String(src));
    const info = await probe(bin, String(src), String(ua ?? ''), String(ref ?? ''));
    if (info) probeCache.set(String(src), info);
    return info;
  });
  ipcMain.handle('dial:decoder-url', (_e, src, ua, ref) => {
    if (!available || !port) return null;
    const q = new URLSearchParams({ t: TOKEN, u: String(src), ua: String(ua ?? ''), ref: String(ref ?? '') });
    return `http://127.0.0.1:${port}/stream?${q}`;
  });

  app.on('before-quit', () => { for (const s of sessions) s.kill('SIGKILL'); server.close(); });
}

module.exports = { start, probe, transcodeArgs };

// Serves the test media like an IPTV provider: raw MPEG-TS live feeds paced at real time
// (with and without a .ts extension), HLS, and an M3U playlist listing them all.
// Usage: node tests/streamlab/server.mjs [--port 8787]   (or PORT=8787)
//
// Buffering lab: /net/<profile>/... serves the same feeds through a simulated bad network
// (see NET_PROFILES), and /net/<profile>/hlslive/index.m3u8 is a real sliding-window live HLS
// channel with slow / variable segment delivery. Impairments are seeded, so every run of a
// profile sees the same sequence of pauses and bursts (fair before/after comparisons).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

const dir = 'tests/streamlab/media';
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT ?? 8787);
// A second lab (other port) must not fight the first one over the UDP / RTMP ports.
const UDP_PORT = 5004 + (PORT - 8787) * 2;
const RTMP_PORT = 1935 + (PORT - 8787);
const feeds = {
  'mpeg2-ac3': 'MPEG-2 1080i + AC-3 (antenna/cable style)',
  'mpeg2-aac': 'MPEG-2 + AAC (engine cannot see the video)',
  'mpeg2-mp2': 'MPEG-2 + MP2 audio (DVB style)',
  'h264-ac3': 'H.264 + AC-3',
  'h264-eac3': 'H.264 + E-AC-3',
  'hevc-aac': 'HEVC/H.265 + AAC',
  'h264-aac': 'H.264 + AAC (control)',
};
const feedFile = (id) => path.join(dir, id.replace('-', '_') + '.ts');
let m3u = '#EXTM3U\n';
for (const [id, name] of Object.entries(feeds)) {
  if (!fs.existsSync(feedFile(id))) continue;
  m3u += `#EXTINF:-1 group-title="Lab",TS ${name}\nhttp://127.0.0.1:${PORT}/live/lab/${id}.ts\n`;
  m3u += `#EXTINF:-1 group-title="Lab",NOEXT ${name}\nhttp://127.0.0.1:${PORT}/live/lab/${id}\n`;
}
if (fs.existsSync(path.join(dir, 'hls_mpeg2', 'index.m3u8'))) m3u += `#EXTINF:-1 group-title="Lab",HLS MPEG-2 + AC-3\nhttp://127.0.0.1:${PORT}/hls/index.m3u8\n`;

// ---- Simulated networks ---------------------------------------------------------------------
// cap: delivery speed as a multiple of the stream's bitrate. every/pause: seconds between pauses
// and their length (the connection delivers nothing). burst: share of pauses that end with the
// whole backlog arriving at once (TCP stall then flush). seg*: HLS segment time-to-first-byte and
// per-segment speed (x bitrate); segSlow: share of segments with a very slow first byte.
const NET_PROFILES = {
  good: { cap: 4, every: [1e9, 1e9], pause: [0, 0], burst: 0, segTtfb: [0, 0.1], segSpeed: [4, 4], segSlow: 0, segSlowTtfb: [0, 0] },
  jitter: { cap: 1.4, every: [10, 20], pause: [1, 4], burst: 0.5, segTtfb: [0.1, 0.8], segSpeed: [1.6, 2.5], segSlow: 0.17, segSlowTtfb: [2, 5] },
  slow: { cap: 1.2, every: [15, 25], pause: [1, 3], burst: 0, segTtfb: [0.3, 1.2], segSpeed: [1.3, 1.8], segSlow: 0.1, segSlowTtfb: [2, 4] },
};
const SEED = Number(process.env.NET_SEED ?? 1234);
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
/** murmur3 finalizer: spreads nearby integers over the whole 32-bit range. */
function mix32(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const between = (r, [a, b]) => a + (b - a) * r();
const fileRate = (file, secs = 60) => fs.statSync(file).size / secs; // all lab media is 60 s

/** Pipe `src` (a real-time live source) to `res` through the profile's simulated network. */
function impair(res, src, byteRate, prof) {
  const r = rng(SEED);
  const q = [];
  let qBytes = 0, credit = 0, waitDrain = false;
  let nextPause = Date.now() + between(r, prof.every) * 1000, pausedUntil = 0, burst = false;
  src.on('data', (c) => { q.push(c); qBytes += c.length; if (qBytes > 64e6) src.pause(); });
  const send = (n) => {
    let sent = 0;
    while (n > 0 && q.length) {
      let c = q[0];
      if (c.length > n) { q[0] = c.subarray(n); c = c.subarray(0, n); } else q.shift();
      qBytes -= c.length; n -= c.length; sent += c.length;
      if (!res.write(c)) { waitDrain = true; res.once('drain', () => { waitDrain = false; }); break; }
    }
    if (qBytes < 32e6) src.resume();
    return sent;
  };
  const tick = setInterval(() => {
    const now = Date.now();
    if (!pausedUntil && now >= nextPause) {
      pausedUntil = now + between(r, prof.pause) * 1000;
      burst = r() < prof.burst;
      nextPause = pausedUntil + between(r, prof.every) * 1000;
    }
    if (pausedUntil) {
      if (now < pausedUntil) return;
      pausedUntil = 0;
      if (burst && !waitDrain) { send(qBytes); return; } // the backlog arrives all at once
    }
    if (waitDrain) return;
    credit = Math.min(credit + prof.cap * byteRate * 0.05, prof.cap * byteRate); // at most 1 s of credit
    credit -= send(Math.floor(credit));
  }, 50);
  res.on('close', () => clearInterval(tick));
}

// Live HLS: a sliding-window channel (4 s segments, 6 in the playlist) made on the fly.
const hlsLiveDir = path.join(dir, `hlslive_run_${PORT}`);
let hlsLive;
let stopping = false;
function startHlsLive() {
  const src = path.join(dir, 'live_h264_aac.ts');
  if (hlsLive || stopping || !fs.existsSync(src)) return;
  fs.rmSync(hlsLiveDir, { recursive: true, force: true });
  fs.mkdirSync(hlsLiveDir, { recursive: true });
  // Loop an MP4 remux, not the .ts: -stream_loop over MPEG-TS drops the first packet (the IDR
  // keyframe) of every loop, so each 60 s seam handed Chromium P/B frames with no keyframe →
  // PIPELINE_ERROR_DECODE once a minute (the "HLS decode error" in the buffering baseline).
  const loopSrc = path.join(dir, 'live_h264_aac.loop.mp4');
  if (!fs.existsSync(loopSrc) || fs.statSync(loopSrc).mtimeMs < fs.statSync(src).mtimeMs) {
    spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c', 'copy', loopSrc], { windowsHide: true });
  }
  const input = fs.existsSync(loopSrc) ? loopSrc : src;
  const hlsOut = (map, d) => ['-map', map, '-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments+temp_file', '-hls_segment_filename', path.join(d, 'seg%05d.ts'), path.join(d, 'index.m3u8')];
  const args = ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', input];
  // ABR channel (master.m3u8): the same feed plus a 360p / 0.9 Mbps rendition from the same
  // ffmpeg, so both renditions' segments share numbers and timestamps.
  if (fs.existsSync(lowSrc)) {
    fs.mkdirSync(path.join(hlsLiveDir, 'lo'), { recursive: true });
    args.push('-re', '-stream_loop', '-1', '-i', lowSrc, ...hlsOut('0', hlsLiveDir), ...hlsOut('1', path.join(hlsLiveDir, 'lo')));
  } else args.push(...hlsOut('0', hlsLiveDir));
  hlsLive = spawn(ffmpeg, args, { windowsHide: true });
  hlsLive.on('close', () => { hlsLive = undefined; setTimeout(startHlsLive, 1000); });
}
const lowSrc = path.join(dir, 'live_h264_aac_low.mp4');
const MASTER = '#EXTM3U\n#EXT-X-VERSION:3\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=4400000,AVERAGE-BANDWIDTH=4200000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\nindex.m3u8\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AVERAGE-BANDWIDTH=950000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\nlo/index.m3u8\n';
const segDur = new Map(); // segment name → EXTINF seconds
const hlsSessions = new Map(); // network profile → { base: first segment number, last: last request time }
function serveHlsLive(req, res, prof, name) {
  if (name === 'master.m3u8') {
    hlsSessions.delete(prof); // a new viewing session (the ABR channel)
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    return res.end(MASTER);
  }
  // The low rendition lives in lo/. Network capacity is absolute: a lo segment arrives at the
  // same byte rate a hi one would (x the profile's speed), so switching down really helps.
  const low = name.startsWith('lo/');
  const f = path.join(hlsLiveDir, low ? 'lo' : '', path.basename(name));
  const n = /seg(\d+)\.ts$/.exec(name)?.[1];
  // Impairments are numbered from the first segment a viewing session asks for (a session ends
  // after 8 s without requests, or when the master playlist is loaded), so every run of a profile meets the same sequence of slow and
  // fast segments however long the lab has been up: before/after runs are comparable.
  const now = Date.now();
  let s = hlsSessions.get(prof);
  if (!s || now - s.last > 8000) { s = { base: null, last: now }; hlsSessions.set(prof, s); }
  s.last = now;
  if (n && s.base === null) s.base = +n;
  // Hash the per-segment seed: an LCG's first outputs for consecutive seeds differ by only
  // 1664525 / 2^32, so segments n, n+1, ... drew almost the same "random" numbers and the jitter
  // profile ran in phases of hundreds of segments all fast or all slow-first-byte (~2.9 h cycle).
  const r = rng(mix32(SEED + (n ? +n - s.base : Math.floor(now / 1000))));
  if (path.basename(name) === 'index.m3u8') {
    return setTimeout(() => {
      if (res.destroyed) return;
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/#EXTINF:([\d.]+),\s*\r?\n(\S+)/g)) segDur.set(m[2], +m[1]);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      res.end(text);
    }, between(r, [0, 0.6]) * 1000);
  }
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const buf = fs.readFileSync(f);
  const ttfb = (r() < prof.segSlow ? between(r, prof.segSlowTtfb) : between(r, prof.segTtfb)) * 1000;
  const rate = (low ? fileRate(path.join(dir, 'live_h264_aac.ts')) : buf.length / (segDur.get(path.basename(name)) ?? 4)) * between(r, prof.segSpeed);
  const wait = setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    let off = 0;
    const tick = setInterval(() => {
      const n2 = Math.min(buf.length - off, Math.ceil(rate * 0.05));
      res.write(buf.subarray(off, off + n2));
      off += n2;
      if (off >= buf.length) { clearInterval(tick); res.end(); }
    }, 50);
    res.on('close', () => clearInterval(tick));
  }, ttfb);
  res.on('close', () => clearTimeout(wait));
}
if (fs.existsSync(path.join(dir, 'live_h264_aac.ts'))) startHlsLive();
for (const p of ['good', 'jitter', 'slow']) {
  const add = (name, url) => { m3u += `#EXTINF:-1 group-title="Net ${p}",${name}\n${url}\n`; };
  add(`NET ${p} TS H.264 + AAC`, `http://127.0.0.1:${PORT}/net/${p}/live/lab/h264-aac.ts`);
  add(`NET ${p} HLS H.264 live`, `http://127.0.0.1:${PORT}/net/${p}/hlslive/index.m3u8`);
  if (fs.existsSync(lowSrc)) add(`NET ${p} HLS ABR 720p/360p`, `http://127.0.0.1:${PORT}/net/${p}/hlslive/master.m3u8`);
  add(`NET ${p} TS MPEG-2 1080i + AC-3`, `http://127.0.0.1:${PORT}/net/${p}/live/lab/mpeg2-ac3.ts`);
}
// VOD (movies / episodes) for the seek + startAt checks (vod.mjs).
if (fs.existsSync(path.join(dir, 'movie_h264_aac.mp4'))) m3u += `#EXTINF:-1 group-title="VOD",VOD MP4 H.264 + AAC\nhttp://127.0.0.1:${PORT}/vod/movie.mp4\n`;
if (fs.existsSync(path.join(dir, 'hls_vod', 'index.m3u8'))) m3u += `#EXTINF:-1 group-title="VOD",VOD HLS H.264 + AAC\nhttp://127.0.0.1:${PORT}/vod/hls/index.m3u8\n`;

// Simultaneous-connection tracking per path (single-connection IPTV accounts): GET /stats
const conns = new Map(), peak = new Map();
function track(req, res) {
  const k = req.url.split('?')[0];
  const n = (conns.get(k) ?? 0) + 1;
  conns.set(k, n);
  peak.set(k, Math.max(peak.get(k) ?? 0, n));
  res.on('close', () => conns.set(k, conns.get(k) - 1));
}

// Request counts + bytes per provider file: GET /stats/requests
const hits = new Map();
function hit(k, bytes) {
  const h = hits.get(k) ?? { requests: 0, bytes: 0 };
  h.requests++;
  h.bytes += bytes;
  hits.set(k, h);
}

/** Stream a file like a real live channel: real-time pace, looping with continuous timestamps. */
function live(res, file, prof) {
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
  const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', file, '-c', 'copy', '-f', 'mpegts', 'pipe:1'], { windowsHide: true });
  if (prof) impair(res, ff.stdout, fileRate(file), prof);
  else ff.stdout.pipe(res);
  const stop = () => ff.kill('SIGKILL');
  res.on('close', stop);
}

// "Works in VLC" compatibility cases (set COMPAT=0 to skip).
const COMPAT = process.env.COMPAT !== '0';
const h264 = path.join(dir, 'h264_aac.ts');
const children = new Set();
if (COMPAT) {
  const add = (name, url) => { m3u += `#EXTINF:-1 group-title="Compat",${name}\n${url}\n`; };
  add('COMPAT Server requires VLC user agent', `http://127.0.0.1:${PORT}/compat/vlc-only.ts`);
  add('COMPAT Login inside the link', `http://viewer:s3cret@127.0.0.1:${PORT}/compat/auth.ts`);
  add('COMPAT Redirect chain', `http://127.0.0.1:${PORT}/compat/redirect`);
  add('COMPAT Wrong content-type', `http://127.0.0.1:${PORT}/compat/wrongtype`);
  add('COMPAT Slow start (8s)', `http://127.0.0.1:${PORT}/compat/slow`);
  if (fs.existsSync(path.join(dir, 'movie_h264_ac3.mkv'))) add('COMPAT Movie MKV + AC-3', `http://127.0.0.1:${PORT}/compat/movie.mkv`);
  if (fs.existsSync(path.join(dir, 'movie_h264_ac3.mp4'))) add('COMPAT Movie MP4 + AC-3 (plays video natively, audio needs decoder)', `http://127.0.0.1:${PORT}/compat/movie.mp4`);
  if (fs.existsSync(path.join(dir, 'radio.mp3'))) add('RADIO MP3 audio-only', `http://127.0.0.1:${PORT}/compat/radio.mp3`);
  add('COMPAT UDP multicast-style link', `udp://@127.0.0.1:${UDP_PORT}`);
  add('COMPAT RTMP link', `rtmp://127.0.0.1:${RTMP_PORT}/live/test`);
  const keep = (args, again) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    children.add(p);
    p.on('close', () => { children.delete(p); if (!stopping) setTimeout(again, 500); });
  };
  // UDP: push a live TS feed continuously (players listen on the port).
  const udp = () => keep(['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', h264, '-c', 'copy', '-f', 'mpegts', `udp://127.0.0.1:${UDP_PORT}?pkt_size=1316`], udp);
  udp();
  // RTMP: ffmpeg as a one-client RTMP server, restarted after each client.
  const rtmp = () => keep(['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', h264, '-c', 'copy', '-f', 'flv', '-listen', '1', `rtmp://127.0.0.1:${RTMP_PORT}/live/test`], rtmp);
  rtmp();
}
const shutdown = () => { stopping = true; for (const c of children) c.kill('SIGKILL'); hlsLive?.kill('SIGKILL'); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function serveFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  if (m) {
    const start = +m[1], end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(Object.fromEntries(peak))); }
  if (u === '/stats/reset') { peak.clear(); res.writeHead(200); return res.end(); }
  // Provider-download counters (guide benchmark: a restart in Manual mode must not download anything).
  if (u === '/stats/requests') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(Object.fromEntries(hits))); }
  if (u === '/stats/requests/reset') { hits.clear(); res.writeHead(200); return res.end(); }
  if (/^\/(live|compat|net|vod)\//.test(u)) track(req, res);
  let prof;
  const net = /^\/net\/(\w+)(\/.*)$/.exec(u);
  if (net) {
    prof = NET_PROFILES[net[1]];
    if (!prof) { res.writeHead(404); return res.end('unknown network profile'); }
    u = net[2];
    if (u.startsWith('/hlslive/')) return serveHlsLive(req, res, prof, u.slice(9));
  }
  if (u.startsWith('/compat/')) {
    const name = u.slice(8);
    if (name === 'vlc-only.ts') {
      if (!/VLC/i.test(req.headers['user-agent'] ?? '')) { res.writeHead(403); return res.end('VLC only'); }
      return live(res, h264);
    }
    if (name === 'auth.ts') {
      if (req.headers.authorization !== 'Basic ' + Buffer.from('viewer:s3cret').toString('base64')) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="tv"' }); return res.end(); }
      return live(res, h264);
    }
    if (name === 'redirect') { res.writeHead(302, { Location: '/compat/redirect2' }); return res.end(); }
    if (name === 'redirect2') { res.writeHead(301, { Location: `http://127.0.0.1:${PORT}/live/lab/h264-aac` }); return res.end(); }
    if (name === 'wrongtype') { const r = res.writeHead.bind(res); res.writeHead = (c, h) => r(c, { ...h, 'Content-Type': 'text/html' }); return live(res, h264); }
    if (name === 'slow') { return setTimeout(() => live(res, h264), 8000); }
    if (name === 'movie.mkv') return serveFile(req, res, path.join(dir, 'movie_h264_ac3.mkv'), 'video/x-matroska');
    if (name === 'movie.mp4') return serveFile(req, res, path.join(dir, 'movie_h264_ac3.mp4'), 'video/mp4');
    if (name === 'radio.mp3') return serveFile(req, res, path.join(dir, 'radio.mp3'), 'audio/mpeg');
  }
  if (u === '/vod/movie.mp4') return serveFile(req, res, path.join(dir, 'movie_h264_aac.mp4'), 'video/mp4');
  if (u.startsWith('/vod/hls/')) {
    const f = path.join(dir, 'hls_vod', path.basename(u));
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' }); return res.end(fs.readFileSync(f)); }
  }
  // Big-provider fixtures (node tests/streamlab/big-provider.mjs): playlist + gzip XMLTV.
  if (u === '/big.m3u' && fs.existsSync(path.join(dir, 'big.m3u'))) {
    // The generated playlist points its url-tvg at port 8787: follow this lab's port.
    const body = Buffer.from(fs.readFileSync(path.join(dir, 'big.m3u'), 'utf8').replaceAll('127.0.0.1:8787', `127.0.0.1:${PORT}`));
    hit(u, body.length);
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end(body);
  }
  if (u === '/big-epg.xml.gz' && fs.existsSync(path.join(dir, 'big-epg.xml.gz'))) {
    const body = fs.readFileSync(path.join(dir, 'big-epg.xml.gz'));
    hit(u, body.length);
    res.writeHead(200, { 'Content-Type': 'application/gzip' }); return res.end(body);
  }
  if (u === '/list.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end(m3u); }
  const m = /^\/live\/lab\/([\w-]+?)(\.ts)?$/.exec(u);
  if (m && feeds[m[1]]) return live(res, feedFile(m[1]), prof);
  if (u.startsWith('/hls/')) {
    const f = path.join(dir, 'hls_mpeg2', path.basename(u));
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' }); return res.end(fs.readFileSync(f)); }
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`stream lab: http://127.0.0.1:${PORT}/list.m3u`));

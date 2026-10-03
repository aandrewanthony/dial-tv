// Serves the test media like an IPTV provider: raw MPEG-TS live feeds paced at real time
// (with and without a .ts extension), HLS, and an M3U playlist listing them all.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

const dir = 'tests/streamlab/media';
const PORT = Number(process.env.PORT ?? 8787);
const feeds = {
  'mpeg2-ac3': 'MPEG-2 1080i + AC-3 (antenna/cable style)',
  'mpeg2-aac': 'MPEG-2 + AAC (engine cannot see the video)',
  'mpeg2-mp2': 'MPEG-2 + MP2 audio (DVB style)',
  'h264-ac3': 'H.264 + AC-3',
  'h264-eac3': 'H.264 + E-AC-3',
  'hevc-aac': 'HEVC/H.265 + AAC',
  'h264-aac': 'H.264 + AAC (control)',
};
let m3u = '#EXTM3U\n';
for (const [id, name] of Object.entries(feeds)) {
  if (!fs.existsSync(path.join(dir, id.replace('-', '_') + '.ts'))) continue;
  m3u += `#EXTINF:-1 group-title="Lab",TS ${name}\nhttp://127.0.0.1:${PORT}/live/lab/${id}.ts\n`;
  m3u += `#EXTINF:-1 group-title="Lab",NOEXT ${name}\nhttp://127.0.0.1:${PORT}/live/lab/${id}\n`;
}
if (fs.existsSync(path.join(dir, 'hls_mpeg2', 'index.m3u8'))) m3u += `#EXTINF:-1 group-title="Lab",HLS MPEG-2 + AC-3\nhttp://127.0.0.1:${PORT}/hls/index.m3u8\n`;

// Simultaneous-connection tracking per path (single-connection IPTV accounts): GET /stats
const conns = new Map(), peak = new Map();
function track(req, res) {
  const k = req.url.split('?')[0];
  const n = (conns.get(k) ?? 0) + 1;
  conns.set(k, n);
  peak.set(k, Math.max(peak.get(k) ?? 0, n));
  res.on('close', () => conns.set(k, conns.get(k) - 1));
}

/** Stream a file like a real live channel: real-time pace, looping with continuous timestamps. */
function live(res, file) {
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
  const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', file, '-c', 'copy', '-f', 'mpegts', 'pipe:1'], { windowsHide: true });
  ff.stdout.pipe(res);
  const stop = () => ff.kill('SIGKILL');
  res.on('close', stop);
}

// "Works in VLC" compatibility cases (set COMPAT=0 to skip).
const COMPAT = process.env.COMPAT !== '0';
const h264 = path.join(dir, 'h264_aac.ts');
if (COMPAT) {
  const add = (name, url) => { m3u += `#EXTINF:-1 group-title="Compat",${name}
${url}
`; };
  add('COMPAT Server requires VLC user agent', `http://127.0.0.1:${PORT}/compat/vlc-only.ts`);
  add('COMPAT Login inside the link', `http://viewer:s3cret@127.0.0.1:${PORT}/compat/auth.ts`);
  add('COMPAT Redirect chain', `http://127.0.0.1:${PORT}/compat/redirect`);
  add('COMPAT Wrong content-type', `http://127.0.0.1:${PORT}/compat/wrongtype`);
  add('COMPAT Slow start (8s)', `http://127.0.0.1:${PORT}/compat/slow`);
  if (fs.existsSync(path.join(dir, 'movie_h264_ac3.mkv'))) add('COMPAT Movie MKV + AC-3', `http://127.0.0.1:${PORT}/compat/movie.mkv`);
  if (fs.existsSync(path.join(dir, 'radio.mp3'))) add('RADIO MP3 audio-only', `http://127.0.0.1:${PORT}/compat/radio.mp3`);
  add('COMPAT UDP multicast-style link', 'udp://@127.0.0.1:5004');
  add('COMPAT RTMP link', 'rtmp://127.0.0.1:1935/live/test');
  // UDP: push a live TS feed continuously (players listen on the port).
  const udp = () => spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', h264, '-c', 'copy', '-f', 'mpegts', 'udp://127.0.0.1:5004?pkt_size=1316'], { windowsHide: true }).on('close', () => setTimeout(udp, 500));
  udp();
  // RTMP: ffmpeg as a one-client RTMP server, restarted after each client.
  const rtmp = () => spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', h264, '-c', 'copy', '-f', 'flv', '-listen', '1', 'rtmp://127.0.0.1:1935/live/test'], { windowsHide: true }).on('close', () => setTimeout(rtmp, 500));
  rtmp();
}

function serveFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const m = /bytes=(d+)-(d*)/.exec(req.headers.range ?? '');
  if (m) {
    const start = +m[1], end = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(Object.fromEntries(peak))); }
  if (u === '/stats/reset') { peak.clear(); res.writeHead(200); return res.end(); }
  if (u.startsWith('/live/') || u.startsWith('/compat/')) track(req, res);
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
    if (name === 'radio.mp3') return serveFile(req, res, path.join(dir, 'radio.mp3'), 'audio/mpeg');
  }
  if (u === '/list.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end(m3u); }
  const m = /^\/live\/lab\/([\w-]+?)(\.ts)?$/.exec(u);
  if (m && feeds[m[1]]) return live(res, path.join(dir, m[1].replace('-', '_') + '.ts'));
  if (u.startsWith('/hls/')) {
    const f = path.join(dir, 'hls_mpeg2', path.basename(u));
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' }); return res.end(fs.readFileSync(f)); }
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`stream lab: http://127.0.0.1:${PORT}/list.m3u`));

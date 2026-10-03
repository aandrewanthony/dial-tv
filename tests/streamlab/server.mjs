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

/** Stream a file like a real live channel: real-time pace, looping with continuous timestamps. */
function live(res, file) {
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
  const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', file, '-c', 'copy', '-f', 'mpegts', 'pipe:1'], { windowsHide: true });
  ff.stdout.pipe(res);
  const stop = () => ff.kill('SIGKILL');
  res.on('close', stop);
}

http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/list.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end(m3u); }
  const m = /^\/live\/lab\/([\w-]+?)(\.ts)?$/.exec(u);
  if (m && feeds[m[1]]) return live(res, path.join(dir, m[1].replace('-', '_') + '.ts'));
  if (u.startsWith('/hls/')) {
    const f = path.join(dir, 'hls_mpeg2', path.basename(u));
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' }); return res.end(fs.readFileSync(f)); }
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`stream lab: http://127.0.0.1:${PORT}/list.m3u`));

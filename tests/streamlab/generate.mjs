// Generates broadcast-format test streams (what antenna TV / IPTV actually send) into tests/streamlab/media.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import ffmpeg from 'ffmpeg-static';

const out = 'tests/streamlab/media';
fs.mkdirSync(`${out}/hls_mpeg2`, { recursive: true });
const src = ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30000/1001', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '60'];
const run = (args) => execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const variants = {
  'mpeg2_ac3.ts': ['-c:v', 'mpeg2video', '-b:v', '8M', '-flags', '+ildct+ilme', '-top', '1', '-c:a', 'ac3', '-b:a', '384k'],
  'mpeg2_mp2.ts': ['-c:v', 'mpeg2video', '-b:v', '8M', '-c:a', 'mp2', '-b:a', '256k'],
  'h264_ac3.ts': ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '5M', '-c:a', 'ac3', '-b:a', '384k'],
  'h264_eac3.ts': ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '5M', '-c:a', 'eac3', '-b:a', '256k'],
  'hevc_aac.ts': ['-c:v', 'libx265', '-preset', 'ultrafast', '-b:v', '4M', '-c:a', 'aac', '-b:a', '160k', '-x265-params', 'log-level=error'],
  'h264_aac.ts': ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '5M', '-c:a', 'aac', '-b:a', '160k'],
};
for (const [name, codec] of Object.entries(variants)) {
  if (fs.existsSync(`${out}/${name}`)) continue;
  try {
    run([...src, ...codec, '-f', 'mpegts', `${out}/${name}`]);
  } catch {
    fs.rmSync(`${out}/${name}`, { force: true });
    console.warn(`skipped ${name}: this ffmpeg build cannot encode it`);
  }
}
if (!fs.existsSync(`${out}/hls_mpeg2/index.m3u8`)) {
  run(['-i', `${out}/mpeg2_ac3.ts`, '-c', 'copy', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_segment_filename', `${out}/hls_mpeg2/s%03d.ts`, `${out}/hls_mpeg2/index.m3u8`]);
}
console.log('test media ready in', out);

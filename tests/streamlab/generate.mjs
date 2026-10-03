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
  'mpeg2_aac.ts': ['-c:v', 'mpeg2video', '-b:v', '8M', '-c:a', 'aac', '-b:a', '160k'],
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
// "Works in VLC" extras: a movie file with AC-3 audio and an audio-only radio stream.
const extra = {
  'movie_h264_ac3.mkv': ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3M', '-c:a', 'ac3', '-b:a', '256k'],
  'movie_h264_ac3.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3M', '-c:a', 'ac3', '-b:a', '256k', '-movflags', '+faststart'],
  'radio.mp3': ['-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=44100', '-t', '120', '-c:a', 'libmp3lame', '-b:a', '128k'],
};
for (const [name, args] of Object.entries(extra)) {
  if (fs.existsSync(`${out}/${name}`)) continue;
  try { run([...args, `${out}/${name}`]); } catch { fs.rmSync(`${out}/${name}`, { force: true }); console.warn(`skipped ${name}`); }
}
if (!fs.existsSync(`${out}/hls_mpeg2/index.m3u8`)) {
  run(['-i', `${out}/mpeg2_ac3.ts`, '-c', 'copy', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_segment_filename', `${out}/hls_mpeg2/s%03d.ts`, `${out}/hls_mpeg2/index.m3u8`]);
}
console.log('test media ready in', out);

// Buffering lab (server.mjs /net/...): a 720p H.264 feed with 2 s keyframes for live HLS, plus VOD
// test movies that Chromium plays natively (MP4 / HLS with AAC) for the seek / startAt checks.
const more = {
  'live_h264_aac.ts': ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000', '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '4M', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts'],
  'movie_h264_aac.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3M', '-g', '50', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
};
for (const [name, args] of Object.entries(more)) {
  if (fs.existsSync(`${out}/${name}`)) continue;
  try { run([...args, `${out}/${name}`]); } catch { fs.rmSync(`${out}/${name}`, { force: true }); console.warn(`skipped ${name}`); }
}
if (!fs.existsSync(`${out}/hls_vod/index.m3u8`) && fs.existsSync(`${out}/movie_h264_aac.mp4`)) {
  fs.mkdirSync(`${out}/hls_vod`, { recursive: true });
  run(['-i', `${out}/movie_h264_aac.mp4`, '-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', `${out}/hls_vod/v%03d.ts`, `${out}/hls_vod/index.m3u8`]);
}
console.log('buffering lab media ready');

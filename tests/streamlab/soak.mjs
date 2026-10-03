// Soak test against a running desktop instance: plays a decoder channel for N seconds and checks that
// playback keeps pace with real time (no stalls), then verifies ffmpeg processes are cleaned up and
// that four decoded channels can run together in Multiview.
// Usage: node tests/streamlab/soak.mjs [cdpPort] [seconds]
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const port = process.argv[2] ?? '9341';
const seconds = Number(process.argv[3] ?? 90);
const ps = (script) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script]).toString().split(/\s+/).filter(Boolean).map(Number);
  } catch { return []; }
};
// Only count Dial TV decoder processes (their args include "-c:a aac"), not the lab server's own ffmpeg.
const decoderPids = () =>
  ps("Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Where-Object { $_.CommandLine -match '-c:a aac' } | ForEach-Object { $_.ProcessId }");
const ffmpegCount = () => decoderPids().length;
const ffmpegCpu = () => {
  const pids = decoderPids();
  if (!pids.length) return [];
  return ps(`Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { @(${pids.join(',')}) -contains $_.IDProcess } | ForEach-Object { $_.PercentProcessorTime }`);
};

const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = b.contexts()[0].pages()[0];
let ok = true;

// 1) Sustained playback of the hardest stream (MPEG-2 1080i + AC-3 → full re-encode).
await page.evaluate(() => { location.hash = '#/watch'; });
await page.waitForSelector('.chanBar input');
await page.fill('.chanBar input', ''); // clear any filter left by the format check
await page.waitForTimeout(500);
await page.evaluate(() => {
  [...document.querySelectorAll('.channels > button')].find((x) => x.textContent.includes('TS MPEG-2 1080i')).click();
});
await page.waitForFunction(() => { const v = document.querySelector('.hero video'); return v && v.currentTime > 1; }, null, { timeout: 60000 });
const start = await page.evaluate(() => ({ t: document.querySelector('.hero video').currentTime, wall: Date.now() }));
let stalls = 0, last = start.t, cpuSamples = [];
for (let i = 0; i < seconds / 5; i++) {
  await page.waitForTimeout(5000);
  const t = await page.evaluate(() => document.querySelector('.hero video').currentTime);
  if (t - last < 3) stalls++;
  last = t;
  cpuSamples.push(...ffmpegCpu());
}
const end = await page.evaluate(() => {
  const v = document.querySelector('.hero video');
  return { t: v.currentTime, wall: Date.now(), engine: document.querySelector('.hero .player').dataset.engine, a: v.webkitAudioDecodedByteCount, dropped: v.getVideoPlaybackQuality().droppedVideoFrames, total: v.getVideoPlaybackQuality().totalVideoFrames };
});
const played = end.t - start.t, wall = (end.wall - start.wall) / 1000;
const ratio = played / wall;
const cpu = cpuSamples.length ? Math.round(cpuSamples.reduce((a, c) => a + c, 0) / cpuSamples.length) : -1;
console.log(`soak: played ${played.toFixed(1)}s in ${wall.toFixed(1)}s wall (ratio ${ratio.toFixed(2)}), stalls=${stalls}, dropped ${end.dropped}/${end.total} frames, engine=${end.engine}, ffmpeg cpu≈${cpu}% of one core`);
if (ratio < 0.95 || stalls > 0 || end.engine !== 'decoder') ok = false;

// 2) Switching away must stop the converter.
const before = ffmpegCount();
await page.evaluate(() => {
  [...document.querySelectorAll('.channels > button')].find((x) => x.textContent.includes('TS H.264 + AAC')).click();
});
await page.waitForTimeout(4000);
const after = ffmpegCount();
console.log(`cleanup: ffmpeg processes ${before} while decoding → ${after} after switching to a direct channel`);
if (after !== 0) ok = false;

// 3) Multiview with four decoded channels.
await page.evaluate(() => { location.hash = '#/multiview'; });
await page.waitForTimeout(1500);
for (const [i, want] of ['TS MPEG-2 1080i', 'TS MPEG-2 + MP2', 'TS H.264 + AC-3', 'TS H.264 + E-AC-3'].entries()) {
  const tile = page.locator('.mvTile').nth(i);
  if (!(await tile.locator('.pickerBtn').count())) await tile.locator('.mvBar button[title="Clear"]').click();
  await tile.locator('.pickerBtn').click();
  await tile.locator('.pickerPop input').fill(want);
  await tile.locator('.pickerList button', { hasText: want }).first().click();
}
await page.waitForTimeout(30000);
const t1 = await page.evaluate(() => [...document.querySelectorAll('.mvTile video')].map((v) => v.currentTime));
await page.waitForTimeout(15000);
const mv = await page.evaluate(() => [...document.querySelectorAll('.mvTile')].map((t) => ({ name: t.querySelector('.mvBar b')?.textContent, t: t.querySelector('video')?.currentTime ?? 0, w: t.querySelector('video')?.videoWidth ?? 0, engine: t.querySelector('.player')?.dataset.engine })));
mv.forEach((m, i) => {
  const adv = m.t - (t1[i] ?? 0);
  const good = adv > 12 && m.w > 0 && m.engine === 'decoder';
  if (!good) ok = false;
  console.log(`multiview ${good ? 'PASS' : 'FAIL'}  ${m.name}: advanced ${adv.toFixed(1)}s in 15s, ${m.w}px, ${m.engine}`);
});
console.log(`multiview ffmpeg processes: ${ffmpegCount()}, cpu per process ≈ ${ffmpegCpu().join(', ')}%`);
await page.evaluate(() => { document.querySelectorAll('.mvBar button[title="Clear"]').forEach((b) => b.click()); location.hash = '#/home'; });
await page.waitForTimeout(4000);
console.log(`after leaving multiview: ffmpeg processes ${ffmpegCount()}`);
if (ffmpegCount() !== 0) ok = false;

console.log(ok ? '\nSOAK PASS' : '\nSOAK FAIL');
await b.close();
process.exit(ok ? 0 : 1);

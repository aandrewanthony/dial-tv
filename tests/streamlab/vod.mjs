// VOD (movie / episode) check: startAt, seeking and onProgress / onEnded through all three paths
// (native MP4, hls.js VOD, built-in decoder for MKV + AC-3), using the real Player in a harness page
// served by the dev server (tests/streamlab/vod.html).
// Usage: DIAL_DEV_URL=http://localhost:1420 LAB_PORT=8787 node tests/streamlab/vod.mjs <cdpPort>
import { chromium } from '@playwright/test';

const port = process.argv[2] ?? '9341';
const DEV = process.env.DIAL_DEV_URL ?? 'http://localhost:1420';
const LAB = process.env.LAB_PORT ?? '8787';
const cases = [
  ['native MP4', `http://127.0.0.1:${LAB}/vod/movie.mp4`, 'native'],
  ['hls.js VOD', `http://127.0.0.1:${LAB}/vod/hls/index.m3u8`, 'hls'],
  ['decoder MKV + AC-3', `http://127.0.0.1:${LAB}/compat/movie.mkv`, 'decoder', '&decoder=always'],
];
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = b.contexts()[0].pages()[0];
const back = page.url();
const parse = (t) => t.split(':').reduce((a, x) => a * 60 + +x, 0);
const elapsed = async () => parse(await page.locator('.vodTime[aria-label=Elapsed]').innerText());
const waitPlaying = () => page.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.paused && v.readyState >= 3 && document.querySelector('.player')?.dataset.status === 'playing'; }, null, { timeout: 45000 });
let ok = true;
for (const [name, url, engine, extra = ''] of cases) {
  const res = { name };
  try {
    await page.goto(`${DEV}/tests/streamlab/vod.html?u=${encodeURIComponent(url)}&startAt=20${extra}`, { waitUntil: 'commit' });
    await page.waitForSelector('.player video', { timeout: 20000 });
    await waitPlaying();
    await page.waitForTimeout(2000);
    res.engine = await page.evaluate(() => document.querySelector('.player').dataset.engine);
    res.start = await elapsed();
    await page.evaluate(() => window.__player.seek(45));
    await page.waitForTimeout(1000);
    await waitPlaying();
    await page.waitForTimeout(2000);
    res.seek = await elapsed();
    await page.evaluate(() => window.__player.seekBy(-10));
    await page.waitForTimeout(1000);
    await waitPlaying();
    await page.waitForTimeout(1000);
    res.back = await elapsed();
    await page.evaluate(() => window.__player.seek(54));
    await page.waitForFunction(() => window.__vod.ended > 0, null, { timeout: 40000 });
    const rec = await page.evaluate(() => window.__vod);
    res.progress = rec.progress.length;
    res.lastProgress = rec.progress.at(-1);
    res.ended = rec.ended;
    res.ok = res.engine === engine && res.start >= 19 && res.start <= 27 && res.seek >= 44 && res.seek <= 52 && res.back >= 35 && res.back <= 44 && res.ended === 1 && res.progress >= 3 && Math.abs(res.lastProgress[1] - 60) < 2;
  } catch (e) {
    res.ok = false;
    res.why = String(e.message).split('\n')[0];
  }
  if (!res.ok) ok = false;
  console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)} ${res.why ?? `engine=${res.engine} startAt20→${res.start}s seek45→${res.seek}s back10→${res.back}s ended=${res.ended} progress calls=${res.progress} last=${res.lastProgress?.map((x) => x.toFixed(1)).join('/')}`}`);
}
await page.goto(back, { waitUntil: 'commit' }).catch(() => {});
await b.close();
process.exit(ok ? 0 : 1);

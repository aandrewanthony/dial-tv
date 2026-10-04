// Buffering benchmark: plays lab channels behind a simulated bad network (server.mjs /net/...) in a
// running Dial TV desktop instance and measures what a viewer feels.
//   startup   click → picture moving
//   stalls    freezes of ≥ 250 ms after the first frame (rebuffers), and their total length
//   skips     forward jumps (live-edge chasing throws away video), and seconds skipped
//   behind    how far behind the live edge playback ended up (wall time since the click minus video played)
//   latency   the player's own live-latency reading (hls.js), when it reports one
// Usage: node tests/streamlab/buffer.mjs <cdpPort> [seconds=90] [filter="NET jitter"] [--buffer=auto|low-latency|balanced|smooth|max] [--json=out.json]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const pos = args.filter((a) => !a.startsWith('--'));
const port = pos[0] ?? '9341';
const seconds = Number(pos[1] ?? 90);
const filter = pos[2] ?? 'NET jitter';
const LAB = process.env.LAB_PORT ?? '8787';
const buffer = opt('buffer');

const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = b.contexts()[0].pages()[0];
// --log: echo the app's console errors / debug lines while measuring.
if (args.includes('--log')) page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /\[dbg\]|\[Player\]/.test(t)) console.log('   [page]', m.type(), t.slice(0, 240)); });
await page.reload();
await page.waitForTimeout(2500);

// Make sure the lab playlist is imported (same as check.mjs).
await page.evaluate(async (lab) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#/settings/sources'; await sleep(1200);
  if (![...document.querySelectorAll('.srcRow')].some((r) => r.textContent.includes(`127.0.0.1:${lab}`))) {
    const inp = document.querySelector('.addPlaylist input[placeholder^="Playlist link"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, `http://127.0.0.1:${lab}/list.m3u`);
    inp.dispatchEvent(new Event('input', { bubbles: true })); await sleep(100);
    inp.closest('form').requestSubmit(); await sleep(4000);
  } else {
    // Reload so a changed lab playlist (new NET / VOD entries) shows up.
    [...document.querySelectorAll('button')].find((x) => /Reload all/.test(x.textContent))?.click(); await sleep(3000);
  }
}, LAB);

// Settings → Playback → Buffer (buttons carry data-pb="buffer:<value>").
if (buffer) {
  await page.evaluate(() => { location.hash = '#/settings/playback'; });
  await page.waitForTimeout(800);
  const btn = page.locator(`[data-pb="buffer:${buffer}"]`);
  if (!(await btn.count())) { console.error(`no Buffer setting "${buffer}" in Settings → Playback`); process.exit(2); }
  await btn.first().click();
  await page.waitForTimeout(300);
}

await page.evaluate(() => { location.hash = '#/watch'; });
await page.waitForSelector('.chanBar input');
await page.fill('.chanBar input', filter);
await page.waitForTimeout(400);
const names = await page.evaluate(() => [...document.querySelectorAll('.channels > button')].map((x) => x.querySelector('b').textContent));
if (!names.length) { console.error(`no channels match "${filter}"`); process.exit(2); }

const rows = [];
for (const name of names) {
  const r = await page.evaluate(async ({ name, seconds }) => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    [...document.querySelectorAll('.channels > button')].find((x) => x.querySelector('b').textContent === name).click();
    const t0 = performance.now();
    let first = null, lastT = null, lastWall = t0, frozenSince = null;
    let stalls = 0, stalled = 0, skips = 0, skipped = 0, played = 0, resets = 0, waiting = 0, error = null, lat = [], ahead = [], heights = [];
    const v0 = document.querySelector('.hero video');
    const onWaiting = () => { if (first !== null) waiting++; };
    v0.addEventListener('waiting', onWaiting);
    const end = t0 + seconds * 1000;
    while (performance.now() < end) {
      await sleep(100);
      const now = performance.now();
      const v = document.querySelector('.hero video');
      const wrap = document.querySelector('.hero .player');
      const err = document.querySelector('.hero .playerState.error span');
      if (err) { error = err.textContent; break; }
      const t = v.currentTime;
      if (first === null) {
        // !paused: a player holding for its start cushion can move currentTime to the first buffered frame while paused.
        if (lastT !== null && t > lastT && v.readyState >= 3 && !v.paused) { first = now; frozenSince = null; }
        lastT = t; lastWall = now;
        continue;
      }
      const dt = t - lastT, dw = (now - lastWall) / 1000;
      if (dt < -0.5) resets++; // the engine reconnected and restarted its timeline
      else if (dt > dw + 0.5) { skips++; skipped += dt - dw; played += dw; } // jumped ahead
      else if (dt > 0.001) played += dt;
      if (dt > 0.001 || dt < -0.5) {
        if (frozenSince !== null && now - frozenSince >= 250) { stalls++; stalled += (now - frozenSince) / 1000; }
        frozenSince = null;
      } else if (frozenSince === null) frozenSince = lastWall;
      lastT = t; lastWall = now;
      if (wrap?.dataset.latency) lat.push(+wrap.dataset.latency);
      if (v.videoHeight) heights.push(v.videoHeight);
      for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.1 && v.buffered.end(i) >= t) ahead.push(v.buffered.end(i) - t);
    }
    const now = performance.now();
    if (frozenSince !== null && now - frozenSince >= 250) { stalls++; stalled += (now - frozenSince) / 1000; }
    v0.removeEventListener('waiting', onWaiting);
    const wrap = document.querySelector('.hero .player');
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      name, engine: wrap?.dataset.engine ?? '?', error,
      startup: first === null ? null : (first - t0) / 1000,
      stalls, stalled, skips, skipped, resets, waiting,
      behind: first === null ? null : (now - t0) / 1000 - played - skipped,
      latency: avg(lat), ahead: avg(ahead),
      // Adaptive streams: share of the time below the tallest rendition seen (quality dropped).
      lowq: heights.length ? heights.filter((h) => h < Math.max(...heights)).length / heights.length : null,
    };
  }, { name, seconds });
  rows.push(r);
  const f = (x, d = 1) => (x == null ? '—' : x.toFixed(d));
  console.log(`${r.name.padEnd(36)} ${r.engine.padEnd(9)} startup ${f(r.startup)}s  stalls ${String(r.stalls).padStart(2)} (${f(r.stalled)}s)  skips ${r.skips} (${f(r.skipped)}s)  behind ${f(r.behind)}s  avg-ahead ${f(r.ahead)}s${r.latency != null ? `  hls-latency ${f(r.latency)}s` : ''}${r.lowq ? `  lowq ${Math.round(r.lowq * 100)}%` : ''}${r.resets ? `  resets ${r.resets}` : ''}${r.error ? `  ERROR ${r.error}` : ''}`);
  await page.waitForTimeout(1500);
}
// Leave the lab channel so its connection closes.
await page.evaluate(() => { location.hash = '#/home'; });
const out = opt('json');
if (out) fs.writeFileSync(out, JSON.stringify({ buffer: buffer ?? 'current', seconds, filter, rows }, null, 2));
await b.close();

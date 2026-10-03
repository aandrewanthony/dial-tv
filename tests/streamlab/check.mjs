// Drives a running Dial TV desktop instance (started with --remote-debugging-port) through every
// lab channel and verifies REAL playback: video frames decoding, audio decoding, time advancing.
// Usage: node tests/streamlab/check.mjs [cdpPort] [filter]
import { chromium } from '@playwright/test';

const port = process.argv[2] ?? '9341';
const filter = process.argv[3] ?? '';
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = b.contexts()[0].pages()[0];
await page.reload();
await page.waitForTimeout(3000);

const results = await page.evaluate(async (filter) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#/settings/sources'; await sleep(1200);
  if (![...document.querySelectorAll('.srcRow')].some((r) => r.textContent.includes('127.0.0.1:8787'))) {
    const inp = document.querySelector('.addPlaylist input[placeholder^="Playlist link"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, 'http://127.0.0.1:8787/list.m3u');
    inp.dispatchEvent(new Event('input', { bubbles: true })); await sleep(100);
    inp.closest('form').requestSubmit(); await sleep(4000);
  }
  location.hash = '#/watch'; await sleep(1500);
  const f = document.querySelector('.chanBar input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, filter);
  f.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300);
  const out = [];
  const names = [...document.querySelectorAll('.channels > button')].map((x) => x.querySelector('b').textContent).filter((n) => /^(TS|NOEXT|HLS) /.test(n));
  for (const name of names) {
    [...document.querySelectorAll('.channels > button')].find((x) => x.querySelector('b').textContent === name).click();
    const t0 = Date.now(); let r = { name, ok: false, why: 'timeout 60s' };
    let base = null;
    while (Date.now() - t0 < 60000) {
      await sleep(1000);
      const v = document.querySelector('.hero video');
      const wrap = document.querySelector('.hero .player');
      const err = document.querySelector('.hero .playerState.error span');
      if (err) { r = { name, ok: false, why: 'ERROR: ' + err.textContent }; break; }
      if (!v || v.readyState < 3 || v.currentTime < 1) continue;
      const snap = { t: v.currentTime, vb: v.webkitVideoDecodedByteCount, ab: v.webkitAudioDecodedByteCount };
      if (!base) { base = snap; continue; }
      if (Date.now() - t0 > 8000 || snap.t - base.t > 4) {
        const video = snap.vb > base.vb && v.videoWidth > 0;
        const audio = snap.ab > base.ab;
        const advancing = snap.t > base.t + 1;
        r = { name, ok: video && audio && advancing, video, audio, advancing, size: `${v.videoWidth}x${v.videoHeight}`, engine: wrap?.dataset.engine ?? '?', secs: Math.round((Date.now() - t0) / 1000) };
        if (r.ok || Date.now() - t0 > 30000) break;
      }
    }
    out.push(r);
  }
  return out;
}, filter);

let pass = 0;
for (const r of results) {
  if (r.ok) pass++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(52)} ${r.why ?? `video=${r.video} audio=${r.audio} advancing=${r.advancing} ${r.size} ${r.engine} (${r.secs}s)`}`);
}
console.log(`\n${pass}/${results.length} channels playing with picture AND sound`);
await b.close();
process.exit(pass === results.length ? 0 : 1);

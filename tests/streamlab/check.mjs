// Drives a running Dial TV desktop instance (started with --remote-debugging-port) through every
// lab channel and verifies REAL playback: video frames decoding, audio decoding, time advancing.
// Usage: node tests/streamlab/check.mjs [cdpPort] [filter]
import { chromium } from '@playwright/test';

const port = process.argv[2] ?? '9341';
const filter = process.argv[3] ?? '';
const LAB = process.env.LAB_PORT ?? '8787'; // the lab server's port (server.mjs --port)
const CHECKED = /^(TS|NOEXT|HLS|COMPAT|RADIO) /; // NET (buffer.mjs) and VOD (vod.mjs) entries have their own tests
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = b.contexts()[0].pages()[0];
await page.reload();
await page.waitForTimeout(3000);

const listing = await (await fetch(`http://127.0.0.1:${LAB}/list.m3u`)).text();
const expected = listing.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('#EXTINF')).map((l) => l.slice(l.indexOf(',') + 1).trim()).filter((n) => CHECKED.test(n) && n.toLowerCase().includes(filter.toLowerCase()));
const results = await page.evaluate(async ({ filter, lab, expected }) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#/settings/sources'; await sleep(1200);
  if (![...document.querySelectorAll('.srcRow')].some((r) => r.textContent.includes(`127.0.0.1:${lab}`))) {
    const inp = document.querySelector('.addPlaylist input[placeholder^="Playlist link"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, `http://127.0.0.1:${lab}/list.m3u`);
    inp.dispatchEvent(new Event('input', { bubbles: true })); await sleep(100);
    inp.closest('form').requestSubmit(); await sleep(4000);
  }
  location.hash = '#/watch'; await sleep(1500);
  const f = document.querySelector('.chanBar input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, filter);
  f.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300);
  const out = [];
  // The Live TV list is virtualized (only visible rows exist), so search for each expected channel by name.
  const names = expected.filter((n) => !/^COMPAT Movie/.test(n));
  const setFilter = (v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); };
  for (const name of names) {
    setFilter(name);
    await sleep(400);
    const btn = [...document.querySelectorAll('.channels > button')].find((x) => x.dataset.raw === name || x.querySelector('b')?.textContent === name);
    if (!btn) { out.push({ name, ok: false, why: 'NOT IMPORTED: not found by search in Live TV' }); continue; }
    btn.click();
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
        const audioOnly = name.startsWith('RADIO');
        r = { name, ok: (audioOnly || video) && audio && advancing, video, audio, advancing, size: `${v.videoWidth}x${v.videoHeight}`, engine: wrap?.dataset.engine ?? '?', secs: Math.round((Date.now() - t0) / 1000) };
        if (r.ok || Date.now() - t0 > 30000) break;
      }
    }
    out.push(r);
  }
  return out;
}, { filter, lab: LAB, expected });

// Movie files are VOD now: they live in Movies & Series, not Live TV. Play them the way a user would.
for (const n of expected.filter((x) => /^COMPAT Movie/.test(x) && !results.some((r) => r.name === x))) {
  const word = /MKV/.test(n) ? 'MKV' : 'MP4';
  const r = await page.evaluate(async ({ n, word }) => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    location.hash = '#/movies';
    await sleep(1500);
    const inp = document.querySelector('input[aria-label="Search library"]');
    if (!inp) return { name: n, ok: false, why: 'Movies page has no search box' };
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, word);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(600);
    const card = [...document.querySelectorAll('.tvCard')].find((c) => c.textContent.includes(word));
    if (!card) return { name: n, ok: false, why: 'NOT IN MOVIES: not classified as a movie' };
    card.click();
    await sleep(600);
    const play = [...document.querySelectorAll('[role="dialog"] button.primary')].find((b) => /Play|Resume/.test(b.textContent));
    if (!play) return { name: n, ok: false, why: 'no Play button in details' };
    play.click();
    const t0 = Date.now(); let base = null; let r = { name: n, ok: false, why: 'timeout 60s' };
    while (Date.now() - t0 < 60000) {
      await sleep(1000);
      const v = document.querySelector('main .player video');
      const err = document.querySelector('main .playerState.error span');
      if (err) return { name: n, ok: false, why: 'ERROR: ' + err.textContent };
      if (!v || v.readyState < 3 || v.currentTime < 1) continue;
      const snap = { t: v.currentTime, vb: v.webkitVideoDecodedByteCount, ab: v.webkitAudioDecodedByteCount };
      if (!base) { base = snap; continue; }
      if (snap.t - base.t > 4) {
        const video = snap.vb > base.vb && v.videoWidth > 0, audio = snap.ab > base.ab, advancing = snap.t > base.t + 1;
        r = { name: n, ok: video && audio && advancing, video, audio, advancing, size: v.videoWidth + 'x' + v.videoHeight, engine: (document.querySelector('main .player')?.dataset.engine ?? '?') + ' (Movies)', secs: Math.round((Date.now() - t0) / 1000) };
        if (r.ok || Date.now() - t0 > 30000) break;
      }
    }
    location.hash = '#/watch';
    return r;
  }, { n, word });
  results.push(r);
}
for (const n of expected) if (!results.some((r) => r.name === n)) results.push({ name: n, ok: false, why: 'NOT IMPORTED: the playlist parser dropped this link' });
let pass = 0;
for (const r of results) {
  if (r.ok) pass++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(52)} ${r.why ?? `video=${r.video} audio=${r.audio} advancing=${r.advancing} ${r.size} ${r.engine} (${r.secs}s)`}`);
}
console.log(`\n${pass}/${results.length} channels playing with picture AND sound`);
await b.close();
process.exit(results.length > 0 && pass === results.length ? 0 : 1);

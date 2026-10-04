// Guide benchmark against a real desktop copy (Electron + CDP) with the big-provider fixture.
//
//   node tests/streamlab/big-provider.mjs                 # once: writes media/big.m3u + big-epg.xml.gz
//   node tests/streamlab/server.mjs --port 8797           # a lab server (any port; LAB=http://127.0.0.1:<port>)
//   npm run dev                                           # Vite on :1420
//   node tests/streamlab/bigbench.mjs [--keep]            # launches its own Electron (DIAL_PROFILE=guidebench)
//
// Fresh profile → add big.m3u → "Load guide" → open the Guide page → restart Electron with the same
// profile and confirm the restart downloads nothing from the provider (Manual refresh policy).
// Reports time to channels, time to guide loaded, main-thread long tasks (PerformanceObserver
// 'longtask'), stored programme count, guide page open time and restart time.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { chromium } from '@playwright/test';

const CDP = Number(process.env.CDP_PORT ?? 9381);
const LAB = process.env.LAB ?? 'http://127.0.0.1:8797';
const DEV = process.env.DIAL_DEV_URL ?? 'http://localhost:1420';
const PROFILE = process.env.DIAL_PROFILE ?? 'guidebench';
const profileDir = path.join(os.tmpdir(), `dial-tv-${PROFILE}`);
const keep = process.argv.includes('--keep');

const BASELINE = {
  note: 'measured before this change (same fixture): loadSources re-downloaded playlist + guide on every start; DOMParser on the main thread',
  guideLongestTaskMs: 2100,
  storedListings: 580714,
  restartDownloads: 'playlist + full XMLTV every start',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lab = async (p) => (await fetch(LAB + p)).text();

let child = null;
function launch() {
  const env = { ...process.env, DIAL_PROFILE: PROFILE, DIAL_DEV_URL: DEV };
  child = spawn(electronPath, ['.', `--remote-debugging-port=${CDP}`], { env, stdio: 'ignore', windowsHide: false });
  return child;
}
function kill() {
  if (!child) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
  child = null;
}
process.on('exit', kill);
process.on('SIGINT', () => { kill(); process.exit(1); });

async function connect() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  for (let i = 0; i < 200; i++) {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(DEV));
    if (page) return { browser, page };
    await sleep(100);
  }
  throw new Error('Dial TV window not found');
}

const OBSERVE = `(() => {
  if (window.__lt) return;
  window.__lt = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: e.startTime, d: e.duration }); }).observe({ type: 'longtask', buffered: true });
})()`;
const mark = (page) => page.evaluate('performance.now()');
async function longTasks(page, from, to = Infinity) {
  const lt = await page.evaluate('window.__lt || []');
  const sel = lt.filter((e) => e.t >= from && e.t < to);
  return { count: sel.length, worstMs: Math.round(Math.max(0, ...sel.map((e) => e.d))), totalMs: Math.round(sel.reduce((a, e) => a + e.d, 0)) };
}
const guideState = (page) => page.evaluate(`(() => { const s = window.__dialGuide.state(); return { loaded: s.loaded, programmes: s.programmes, matched: s.matched, liveChannels: s.liveChannels, days: s.days, lastLoadMs: s.lastLoadMs, mode: s.mode, status: s.status, programsInMemory: s.programsInMemory }; })()`);
const storedCount = (page) => page.evaluate(`new Promise((res, rej) => {
  const q = indexedDB.open('dial-tv-guide', 1);
  q.onerror = () => rej(q.error);
  q.onsuccess = () => { const g = q.result.transaction('guide').objectStore('guide').get('cache'); g.onsuccess = () => { const c = g.result; res(c ? { programmes: c.data.length / 7, bytes: c.data.byteLength + c.strings.length * 2 + c.channels.length * 2 } : null); q.result.close(); }; };
})`);

async function main() {
  await fetch(`${LAB}/stats/requests`).catch(() => { throw new Error(`Lab server not reachable at ${LAB} (node tests/streamlab/server.mjs --port 8797)`); });
  if (!keep) fs.rmSync(profileDir, { recursive: true, force: true });
  const out = { fixture: {}, fresh: {}, restart: {} };
  const m3u = fs.readFileSync('tests/streamlab/media/big.m3u', 'utf8');
  out.fixture = { playlistEntries: (m3u.match(/#EXTINF/g) ?? []).length, epgGzBytes: fs.statSync('tests/streamlab/media/big-epg.xml.gz').size, epgXmlBytes: fs.statSync('tests/streamlab/media/big-epg.xml').size };

  // ---------- fresh profile ----------
  launch();
  let { browser, page } = await connect();
  await page.evaluate(OBSERVE);
  if (!page.url().includes('#/watch')) await page.evaluate(`location.hash = '#/watch'`);
  await page.getByPlaceholder('Playlist link').waitFor({ timeout: 60_000 });
  await lab('/stats/requests/reset');

  let t = await mark(page);
  let w = Date.now();
  await page.getByPlaceholder('Playlist link').fill(`${LAB}/big.m3u`);
  await page.getByRole('button', { name: 'Add link' }).click();
  await page.locator('.channels > button').first().waitFor({ timeout: 60_000 });
  out.fresh.timeToChannelsMs = Date.now() - w;
  out.fresh.channelLoadLongTasks = await longTasks(page, t);
  await sleep(1500);
  const afterPlaylist = JSON.parse(await lab('/stats/requests'));
  out.fresh.guideDownloadedWithoutAsking = !!afterPlaylist['/big-epg.xml.gz'];

  await page.evaluate(`location.hash = '#/guide'`);
  const loadBtn = page.locator('.guideCta').getByRole('button', { name: 'Load guide' });
  await loadBtn.waitFor({ timeout: 30_000 });
  t = await mark(page);
  w = Date.now();
  await loadBtn.click();
  await page.waitForFunction(`(document.querySelector('[data-guide-status]')?.textContent || '').startsWith('Guide loaded')`, null, { timeout: 180_000, polling: 50 });
  out.fresh.timeToGuideLoadedMs = Date.now() - w;
  const t2 = await mark(page);
  out.fresh.guideLoadLongTasks = await longTasks(page, t, t2);
  out.fresh.guide = await guideState(page);
  out.fresh.stored = await storedCount(page);
  await page.locator('.gProg').first().waitFor({ timeout: 30_000 });

  await page.evaluate(`location.hash = '#/home'`);
  await sleep(1000);
  t = await mark(page);
  w = Date.now();
  await page.evaluate(`location.hash = '#/guide'`);
  await page.locator('.gProg').first().waitFor({ timeout: 30_000 });
  out.fresh.guidePageOpenMs = Date.now() - w;
  out.fresh.guidePageOpenLongTasks = await longTasks(page, t);
  // Horizontal scroll smoothness: scroll the grid and count long tasks.
  t = await mark(page);
  await page.evaluate(`(async () => { const g = document.querySelector('.grid'); for (let i = 0; i < 40; i++) { g.scrollLeft += 120; g.scrollTop += 60; await new Promise((r) => requestAnimationFrame(r)); } })()`);
  out.fresh.scrollLongTasks = await longTasks(page, t);
  out.fresh.requests = JSON.parse(await lab('/stats/requests'));
  await browser.close().catch(() => undefined);
  kill();
  await sleep(1500);

  // ---------- restart with the same profile ----------
  await lab('/stats/requests/reset');
  w = Date.now();
  launch();
  ({ browser, page } = await connect());
  await page.evaluate(OBSERVE);
  if (!page.url().includes('#/watch')) await page.evaluate(`location.hash = '#/watch'`);
  await page.locator('.channels > button').first().waitFor({ timeout: 60_000 });
  out.restart.toChannelsMs = Date.now() - w;
  await page.waitForFunction(`!!window.__dialGuide && window.__dialGuide.state().loaded && window.__dialGuide.state().matched > 0`, null, { timeout: 60_000, polling: 20 });
  out.restart.toGuideReadyMs = Date.now() - w;
  t = await mark(page);
  const w2 = Date.now();
  await page.evaluate(`location.hash = '#/guide'`);
  await page.locator('.gProg').first().waitFor({ timeout: 30_000 });
  out.restart.guidePageOpenMs = Date.now() - w2;
  out.restart.guide = await guideState(page);
  out.restart.startupLongTasks = await longTasks(page, 0);
  await sleep(3000);
  out.restart.providerRequests = JSON.parse(await lab('/stats/requests'));
  out.restart.providerBytes = Object.values(out.restart.providerRequests).reduce((a, h) => a + h.bytes, 0);
  await browser.close().catch(() => undefined);
  kill();

  out.baseline = BASELINE;
  out.targets = {
    noLongTaskOver200msDuringGuideLoad: out.fresh.guideLoadLongTasks.worstMs <= 200,
    storedAbout101k: out.fresh.stored ? Math.abs(out.fresh.stored.programmes - 101295) / 101295 < 0.35 : false,
    restartLoadsZeroBytes: out.restart.providerBytes === 0,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  kill();
  process.exit(1);
});

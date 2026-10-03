// Simulates a provider dropping the connection mid-stream: kills the lab server while a channel
// plays, restarts it, and checks that playback resumes on its own (no error screen).
// Usage: node tests/streamlab/reconnect.mjs [cdpPort]
import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';

const port = process.argv[2] ?? '9345';
const killLab = () => execFileSync('powershell', ['-NoProfile', '-Command',
  "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'streamlab.server') -or ($_.Name -eq 'ffmpeg.exe' -and $_.CommandLine -match 'stream_loop') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"]);
const startLab = () => spawn(process.execPath, ['tests/streamlab/server.mjs'], { stdio: 'ignore', detached: true }).unref();

const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = b.contexts()[0].pages()[0];
let ok = true;
for (const name of ['TS H.264 + AAC (control)', 'TS MPEG-2 1080i']) {
  await page.evaluate(() => { location.hash = '#/watch'; });
  await page.waitForSelector('.chanBar input');
  await page.fill('.chanBar input', '');
  await page.locator('.channels > button', { hasText: name }).first().click();
  await page.waitForFunction(() => { const v = document.querySelector('.hero video'); return v && v.currentTime > 3; }, null, { timeout: 60000 });
  const engine = await page.evaluate(() => document.querySelector('.hero .player').dataset.engine);
  killLab();
  await page.waitForTimeout(8000); // provider down for 8 s
  startLab();
  const t0 = await page.evaluate(() => document.querySelector('.hero video').currentTime);
  let resumed = false, err = null;
  for (let i = 0; i < 30 && !resumed; i++) {
    await page.waitForTimeout(2000);
    const st = await page.evaluate(() => ({ t: document.querySelector('.hero video').currentTime, e: document.querySelector('.hero .playerState.error span')?.textContent ?? null }));
    if (st.e) { err = st.e; break; }
    if (st.t > t0 + 5) resumed = true;
  }
  console.log(`${resumed ? 'PASS' : 'FAIL'}  ${name} [${engine}]: ${resumed ? 'resumed after an 8 s outage' : err ? 'ERROR ' + err : 'did not resume within 60 s'}`);
  if (!resumed) ok = false;
}
await b.close();
process.exit(ok ? 0 : 1);

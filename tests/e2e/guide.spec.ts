import { test, expect, type Page } from '@playwright/test';
import { gzipSync } from 'node:zlib';

/**
 * Guide: downloads by itself from the playlist's guide link; it is parsed in a worker, stored, and a
 * reload ("restart") uses the stored guide without downloading it again.
 */
const PLAYLIST = [
  '#EXTM3U url-tvg="https://epg.test/guide.xml"',
  '#EXTINF:-1 tvg-id="news.us" group-title="News",US| Dial News HD',
  'https://live.test/news.m3u8',
  '#EXTINF:-1 tvg-id="sports.us" group-title="Sports",US| Dial Sports FHD',
  'https://live.test/sports.m3u8',
  '#EXTINF:-1 group-title="Sports",US| Dial Sports 4K',
  'https://live.test/sports4k.m3u8',
  '#EXTINF:-1 group-title="Other",Mystery Channel',
  'https://live.test/mystery.m3u8',
].join('\n');

const H = 3600_000;
const fmt = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
};
function guideXml(prefix = '') {
  const t0 = Math.floor(Date.now() / H) * H;
  const progs: string[] = [];
  for (let i = -2; i < 30; i++) {
    progs.push(`<programme start="${fmt(t0 + i * H)}" stop="${fmt(t0 + (i + 1) * H)}" channel="sports.us"><title>${prefix}Game Night ${i}</title><category>Sports</category></programme>`);
    progs.push(`<programme start="${fmt(t0 + i * H)}" stop="${fmt(t0 + (i + 1) * H)}" channel="news.us"><title>${prefix}Headlines ${i}</title></programme>`);
    progs.push(`<programme start="${fmt(t0 + i * H)}" stop="${fmt(t0 + (i + 1) * H)}" channel="mystery.x"><title>${prefix}Mystery Hour ${i}</title></programme>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="sports.us"><display-name>Dial Sports</display-name></channel><channel id="news.us"><display-name>Dial News</display-name></channel><channel id="mystery.x"><display-name>Mystery Ch</display-name></channel>${progs.join('')}</tv>`;
}

let epgRequests = 0;

async function setup(page: Page) {
  epgRequests = 0;
  const ctx = page.context();
  await ctx.route('https://site.api.espn.com/**', (r) => r.fulfill({ json: { events: [], children: [] } }));
  await ctx.route('https://api.sleeper.app/**', (r) => r.fulfill({ status: 404, json: null }));
  await ctx.route('https://playlist.test/**', (r) => r.fulfill({ body: PLAYLIST, headers: { 'access-control-allow-origin': '*' } }));
  await ctx.route('https://epg.test/**', (r) => {
    epgRequests++;
    return r.fulfill({ body: gzipSync(guideXml()), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/gzip' } });
  });
  await ctx.route(/live\.test/, (r) => r.abort());
}

async function addPlaylist(page: Page) {
  await page.goto('/#/watch');
  await page.getByPlaceholder('Playlist link').fill('https://playlist.test/tv.m3u');
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.locator('.channels > button').first()).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => setup(page));

test('guide loads by itself online, shows status + listings, and a restart uses the stored guide', async ({ page }) => {
  await addPlaylist(page);
  // The playlist advertises a guide: it downloads on its own, no button.
  await page.goto('/#/guide');
  await expect(page.locator('[data-guide-status]')).toContainText(/Guide loaded .* · 2 of 3 channels matched · 3 days/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /Load guide|Refresh guide/ })).toHaveCount(0);
  expect(epgRequests).toBe(1);
  await expect(page.locator('.guideCta')).toHaveCount(0);
  await expect(page.locator('.gRow', { hasText: 'Dial Sports' }).locator('.gProg').first()).toContainText('Game Night');
  await expect(page.locator('.gRow', { hasText: 'Dial News' }).locator('.gProg').first()).toContainText('Headlines');
  // Channels without listings get a compact row.
  await expect(page.locator('.gRow.gRowEmpty', { hasText: 'Mystery Channel' })).toContainText('No listings');

  // Filters.
  await page.getByLabel('Filter channels').fill('news');
  await expect(page.locator('.gRow')).toHaveCount(1);
  await page.getByLabel('Filter channels').fill('');

  // Restart: listings come back from this device, nothing is downloaded.
  await page.reload();
  await expect(page.locator('[data-guide-status]')).toContainText('Guide loaded', { timeout: 10_000 });
  await expect(page.locator('.gRow', { hasText: 'Dial Sports' }).locator('.gProg').first()).toContainText('Game Night');
  await page.waitForTimeout(500);
  expect(epgRequests).toBe(1);

  // Live TV shows what's on from the stored guide.
  await page.goto('/#/watch');
  await page.locator('.channels > button', { hasText: 'Dial Sports' }).first().click();
  await expect(page.locator('.now')).toContainText('Game Night 0');
});

test('mapping panel maps an unmatched channel to a guide channel', async ({ page }) => {
  await addPlaylist(page);
  await page.goto('/#/guide');
  await expect(page.locator('[data-guide-status]')).toContainText('Guide loaded', { timeout: 15_000 });
  await page.goto('/#/settings/mapping');
  const panel = page.getByRole('region', { name: 'Guide mapping' });
  await expect(panel).toContainText('2 of 3 channels have listings');
  const row = panel.locator('.mapRow', { hasText: 'Mystery Channel' });
  await expect(row).toBeVisible();
  // Suggestion by name, one click to accept.
  await row.getByRole('button', { name: /Use Mystery Ch/ }).click();
  // Mapped after the guide was loaded: its listings download by themselves.
  await expect(panel).toContainText('3 of 3 channels have listings', { timeout: 15_000 });
  expect(epgRequests).toBe(2);
  await page.goto('/#/guide');
  await expect(page.locator('.gRow', { hasText: 'Mystery Channel' }).locator('.gProg').first()).toContainText('Mystery Hour');
});

test('imported XMLTV file (.xml.gz) is parsed by the worker', async ({ page }) => {
  await addPlaylist(page);
  await page.goto('/#/settings/sources');
  // Remove the auto-discovered URL guide so only the file is used.
  await page.getByRole('button', { name: /Remove guide/ }).click();
  await page.locator('input[type=file][accept=".xml,.xmltv,.gz"]').setInputFiles({ name: 'guide.xml.gz', mimeType: 'application/gzip', buffer: gzipSync(guideXml('File ')) });
  const panel = page.getByRole('region', { name: 'Guide data' });
  await expect(panel.locator('[data-guide-status]')).toContainText('2 of 3 channels matched', { timeout: 15_000 });
  await expect(panel).toContainText('guide.xml.gz');
  expect(epgRequests).toBe(0);
  await page.goto('/#/guide');
  await expect(page.locator('.gRow', { hasText: 'Dial News' }).locator('.gProg').first()).toContainText('File Headlines');
});

import { test, expect, type Page } from '@playwright/test';

/**
 * TV section: Movies & Series library, guide overlay over Live TV, and My Channels.
 * The playlist mixes live channels, movies (/movie/ paths, .mp4) and series episodes; video hosts are aborted.
 */
const PLAYLIST = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="news.us" group-title="News",Dial News',
  'https://live.test/news.m3u8',
  '#EXTINF:-1 tvg-id="sports.us" group-title="Sports",Dial Sports',
  'https://live.test/sports.m3u8',
  '#EXTINF:-1 group-title="VOD Action",Heat (1995)',
  'https://vod.test/movie/u/p/1001.mp4',
  '#EXTINF:-1 group-title="VOD Comedy",Airplane! (1980)',
  'https://vod.test/movie/u/p/1002.mkv',
  '#EXTINF:-1 group-title="Movies",Big Buck Bunny',
  'https://vod.test/files/bbb.mp4',
  '#EXTINF:-1 group-title="Series",Breaking Bad S01E01',
  'https://vod.test/series/u/p/2001.mkv',
  '#EXTINF:-1 group-title="Series",Breaking Bad S01E02',
  'https://vod.test/series/u/p/2002.mkv',
  '#EXTINF:-1 group-title="Series",Breaking Bad S02E01',
  'https://vod.test/series/u/p/2003.mkv',
  '#EXTINF:-1 group-title="Series",The Office 1x01',
  'https://vod.test/series/u/p/3001.mp4',
].join('\n');

async function setup(page: Page) {
  await page.route('https://site.api.espn.com/**', (r) => r.fulfill({ json: { events: [], children: [] } }));
  await page.route('https://api.sleeper.app/**', (r) => r.fulfill({ status: 404, json: null }));
  await page.route('https://playlist.test/**', (r) => r.fulfill({ body: PLAYLIST, headers: { 'access-control-allow-origin': '*' } }));
  await page.route(/live\.test|vod\.test/, (r) => r.abort());
  await page.goto('/#/watch');
  await page.getByPlaceholder('Playlist link').fill('https://playlist.test/tv.m3u');
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.locator('.channels > button')).toHaveCount(2, { timeout: 10_000 });
}

test.beforeEach(async ({ page }) => setup(page));

test('movies and series go to Movies & Series, not Live TV', async ({ page }) => {
  await expect(page.locator('.channels')).not.toContainText('Heat');
  await expect(page.locator('.channels')).not.toContainText('Breaking Bad');
  await page.goto('/#/movies');
  const grid = page.getByRole('list', { name: 'Movies' });
  await expect(grid).toContainText('Heat');
  await expect(grid).toContainText('Airplane!');
  await expect(grid).toContainText('Big Buck Bunny');
  await expect(page.getByRole('tab', { name: /Movies · 3/ })).toBeVisible();

  // Series are grouped by show.
  await page.getByRole('tab', { name: /Series · 2/ }).click();
  const shows = page.getByRole('list', { name: 'Series' });
  await expect(shows.locator('.tvCard')).toHaveCount(2);
  await expect(shows.locator('.tvCard', { hasText: 'Breaking Bad' })).toContainText('2 seasons · 3 ep');

  // Search filters.
  await page.getByRole('tab', { name: /Movies/ }).click();
  await page.getByLabel('Search library').fill('air');
  await expect(grid.locator('.tvCard')).toHaveCount(1);
});

test('details: show seasons and episodes, open the movie player view', async ({ page }) => {
  await page.goto('/#/movies');
  await page.getByRole('tab', { name: /Series/ }).click();
  await page.locator('.tvCard', { hasText: 'Breaking Bad' }).click();
  const dlg = page.getByRole('dialog', { name: 'Breaking Bad' });
  await expect(dlg.getByRole('tab', { name: 'Season 1' })).toBeVisible();
  await expect(dlg.locator('.tvEpisode')).toHaveCount(2);
  await dlg.getByRole('tab', { name: 'Season 2' }).click();
  await expect(dlg.locator('.tvEpisode')).toHaveCount(1);
  await expect(dlg.getByRole('button', { name: 'Play S1 E1' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: /Movies/ }).click();
  await page.locator('.tvCard', { hasText: 'Heat' }).click();
  const md = page.getByRole('dialog', { name: 'Heat' });
  await expect(md).toContainText('1995');
  await md.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page).toHaveURL(/#\/movies\/.+/);
  await expect(page.locator('.tvVodTitle')).toContainText('Heat');
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByRole('list', { name: 'Movies' })).toBeVisible();
});

test('guide overlay opens over Live TV with G, moves with arrows, closes with Esc', async ({ page }) => {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('g');
  const overlay = page.getByRole('region', { name: 'Guide overlay' });
  await expect(overlay).toBeVisible();
  await expect(page).toHaveURL(/#\/watch/); // did not jump to the Guide page
  await expect(overlay.locator('.tvGuideRow.on')).toContainText('Dial News');
  await page.keyboard.press('ArrowDown');
  await expect(overlay.locator('.tvGuideRow.on')).toContainText('Dial Sports');
  await page.keyboard.press('ArrowUp');
  await expect(overlay.locator('.tvGuideRow.on')).toContainText('Dial News');
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();

  // The button works too, and Enter tunes the highlighted channel.
  await page.locator('.now').getByRole('button', { name: 'Guide' }).click();
  await expect(overlay).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(overlay).toBeHidden();
  await expect(page.locator('.now h2')).toHaveText('Dial Sports');
  // Channel change shows the info banner.
  await expect(page.locator('.tvBanner')).toContainText('Dial Sports');
});

test('my channels: create a personal channel and see it in Live TV and the guides', async ({ page }) => {
  await page.goto('/#/channels');
  await page.getByRole('button', { name: 'New channel' }).click();
  const dlg = page.getByRole('dialog', { name: 'New channel' });
  await dlg.getByLabel('Channel name').fill('Movie Night');
  await dlg.getByLabel('Search your library').fill('heat');
  await dlg.getByRole('button', { name: 'Add Heat' }).click();
  await dlg.getByLabel('Search your library').fill('breaking');
  await dlg.getByRole('button', { name: 'Add show Breaking Bad' }).click();
  await expect(dlg.locator('.tvLineupRow')).toHaveCount(4);
  await expect(dlg.locator('.tvPreviewList')).toContainText('Heat');
  await dlg.getByRole('button', { name: 'Create channel' }).click();

  const card = page.locator('.tvPCard', { hasText: 'Movie Night' });
  await expect(card).toContainText('CH 900');
  await expect(card).toContainText('NOW');
  await expect(card).toContainText('Heat');

  // Program guide lists it with computed programs.
  await page.goto('/#/guide');
  const row = page.locator('.gRow', { hasText: 'Movie Night' });
  await expect(row).toBeVisible();
  await expect(row.locator('.gProg').first()).toContainText(/Heat|Breaking Bad/);

  // Live TV lists it under My Channels; the overlay shows its listings.
  await page.goto('/#/watch');
  await expect(page.locator('.channels > button', { hasText: 'Movie Night' })).toBeVisible();
  await page.locator('.channels > button', { hasText: 'Movie Night' }).click();
  await expect(page.locator('.now h2')).toHaveText('Movie Night');
  await expect(page.locator('.now')).toContainText('Heat');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('g');
  await expect(page.locator('.tvGuideRow.on')).toContainText('Movie Night');
  await expect(page.locator('.tvGuideRow.on .tvGuideProg.live')).toContainText('Heat');
  await page.keyboard.press('Escape');

  // Number entry reaches personal channels.
  await page.locator('.channels > button', { hasText: 'Dial News' }).click();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (const k of ['9', '0', '0']) await page.keyboard.press(k);
  await expect(page.locator('.now h2')).toHaveText('Movie Night', { timeout: 5000 });
});

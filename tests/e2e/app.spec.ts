import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Deterministic E2E: ESPN + Sleeper are mocked from fixtures; external video hosts are
 * aborted (we assert the player's UI states, not third-party stream availability).
 */
const scoreboard = JSON.parse(readFileSync(resolve('tests/fixtures/espn-nfl.json'), 'utf8'));
const playlist = readFileSync(resolve('tests/fixtures/sports.m3u'), 'utf8');
const guide = readFileSync(resolve('tests/fixtures/guide.xml'), 'utf8');

async function mockNetwork(page: Page) {
  await page.route('https://site.api.espn.com/**', (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.includes('/football/nfl/scoreboard')) return route.fulfill({ json: { events: [], children: [] } });
    // Only serve the fixture for "today" so games aren't duplicated across days; make the upcoming game tomorrow.
    const today = new Date();
    const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    if (url.searchParams.get('dates') !== ymd) return route.fulfill({ json: { events: [] } });
    const data = structuredClone(scoreboard);
    data.events[1].date = new Date(Date.now() + 26 * 3600_000).toISOString();
    data.events[0].date = new Date(Date.now() - 3 * 3600_000).toISOString();
    return route.fulfill({ json: data });
  });
  await page.route('https://api.sleeper.app/**', (route) => route.fulfill({ status: 404, json: null }));
  await page.route('https://playlist.test/**', (route) => route.fulfill({ body: playlist, headers: { 'access-control-allow-origin': '*' } }));
  await page.route('http://localhost:1420/__test/guide.xml', (route) => route.fulfill({ body: guide, contentType: 'application/xml' }));
  await page.route(/test-streams\.mux\.dev|unified-streaming|devstreaming-cdn|bitdash-a|espncdn|sleepercdn/, (route) => route.abort());
}

test.beforeEach(async ({ page }) => {
  await mockNetwork(page);
});

test('navigates every page without runtime errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  for (const [hash, heading] of [
    ['watch', 'Live TV'], ['guide', 'Program Guide'], ['movies', 'Movies & Series'], ['channels', 'My Channels'], ['multiview', 'Multiview'],
    ['home', 'Your Sports Command Center'], ['sports', 'Scores'], ['teams', 'My Teams'], ['fantasy', 'Fantasy Live'], ['bets', 'Bets & Odds'],
    ['schedule', 'Smart Schedule'], ['settings', 'Settings'],
  ]) {
    await page.goto(`/#/${hash}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
  }
  expect(errors).toEqual([]);
});

test('sports page shows mocked games with odds', async ({ page }) => {
  await page.goto('/#/sports');
  await expect(page.locator('.gameCard').filter({ hasText: 'Steelers' })).toContainText('Final', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Tomorrow' }).click();
  await expect(page.locator('.gameCard').filter({ hasText: 'Colts' })).toContainText('IND -4.5');
});

test('schedule: create a custom block, it persists, conflicts are flagged', async ({ page }) => {
  await page.goto('/#/schedule');
  for (const title of ['Watch party', 'Overlap']) {
    await page.getByRole('button', { name: 'Custom block' }).click();
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Save' }).click();
  }
  await expect(page.locator('.block')).toHaveCount(2);
  await expect(page.locator('.banner.warn')).toContainText('overlap');
  await page.reload();
  await page.getByRole('button', { name: 'Agenda' }).click();
  await expect(page.locator('.agendaRow')).toHaveCount(2);
});

test('watch: starts empty, add your own playlist, number entry tunes, dead stream shows retry', async ({ page }) => {
  await page.goto('/#/watch');
  await expect(page.getByRole('heading', { name: 'Add your channels' })).toBeVisible();
  await page.getByPlaceholder('Playlist link').fill('https://playlist.test/my.m3u');
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.locator('.channels > button')).toHaveCount(5, { timeout: 10_000 });
  await expect(page.locator('.channels')).not.toContainText('Big Buck Bunny');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (const k of ['2', '0', '2']) await page.keyboard.press(k);
  await expect(page.locator('.now h2')).toHaveText('FOX (WNYW) New York', { timeout: 5000 });
  await expect(page.locator('.playerState.error')).toContainText('Retry', { timeout: 40_000 });
  await page.reload();
  await expect(page.locator('.channels > button')).toHaveCount(5, { timeout: 10_000 }); // playlist persisted
});

test('global search finds channels and teams', async ({ page }) => {
  await page.goto('/#/home');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Channel, show, team, league…').fill('colts');
  await expect(page.locator('.palList')).toContainText('Indianapolis Colts');
});

test('mobile layout uses bottom navigation @mobile', async ({ page }) => {
  await page.goto('/#/home');
  const nav = page.locator('.nav');
  await expect(nav).toBeVisible();
  const box = await nav.boundingBox();
  expect(box!.y).toBeGreaterThan(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

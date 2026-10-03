import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Deterministic E2E: ESPN + Sleeper are mocked from fixtures; external video hosts are
 * aborted (we assert the player's UI states, not third-party stream availability).
 */
const scoreboard = JSON.parse(readFileSync(resolve('tests/fixtures/espn-nfl.json'), 'utf8'));

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
    ['home', 'Your Sports Command Center'], ['watch', 'Live Television'], ['guide', 'Program Guide'], ['sports', 'Sports Center'],
    ['fantasy', 'Fantasy Live'], ['picks', 'Picks & Odds'], ['multiview', 'Multiview'], ['schedule', 'My Schedule'], ['settings', 'Settings'],
  ]) {
    await page.goto(`/#/${hash}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
  }
  expect(errors).toEqual([]);
});

test('sports page shows mocked games with odds and the ticker', async ({ page }) => {
  await page.goto('/#/sports');
  await expect(page.locator('.gameCard').filter({ hasText: 'Steelers' })).toContainText('Final', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Tomorrow' }).click();
  await expect(page.locator('.gameCard').filter({ hasText: 'Colts' })).toContainText('IND -4.5');
  await expect(page.locator('.bottomLine')).toContainText('PIT 24 · CLE 27');
});

test('pick flow: make a spread pick and see it in the ledger and leaderboard', async ({ page }) => {
  await page.goto('/#/picks');
  const btn = page.locator('.oddBtn', { hasText: '-4.5' }).first();
  await btn.click();
  await expect(btn).toHaveClass(/on/);
  await expect(page.locator('.ledger')).toContainText('IND -4.5');
  await expect(page.locator('.lb').first()).toContainText('1 open');
  await page.reload();
  await expect(page.locator('.ledger')).toContainText('IND -4.5'); // persisted
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

test('watch: channel number entry tunes, and an unreachable stream shows a retry state', async ({ page }) => {
  await page.goto('/#/watch');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('1');
  await page.keyboard.press('0');
  await page.keyboard.press('3');
  await expect(page.locator('.now h2')).toHaveText('Apple Demo', { timeout: 5000 });
  await expect(page.locator('.playerState.error')).toContainText('Retry', { timeout: 15_000 });
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

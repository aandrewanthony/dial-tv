import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';

/**
 * Channel organization with a realistic big-provider playlist (tests/streamlab/big-provider.mjs):
 * 6000 live entries (1047 real channels in 1–4 quality copies), 14 countries, ~340 messy groups.
 * The playlist is served through page.route; streams and the guide are aborted.
 */
const BIG = 'tests/streamlab/media/big.m3u';

test.beforeAll(() => {
  if (!fs.existsSync(BIG)) execFileSync(process.execPath, ['tests/streamlab/big-provider.mjs'], { stdio: 'ignore' });
});

async function addBig(page: Page) {
  const body = fs.readFileSync(BIG, 'utf8');
  await page.route('https://site.api.espn.com/**', (r) => r.fulfill({ json: { events: [], children: [] } }));
  await page.route('https://api.sleeper.app/**', (r) => r.fulfill({ status: 404, json: null }));
  await page.route('https://big.test/**', (r) => r.fulfill({ body, headers: { 'access-control-allow-origin': '*' } }));
  await page.route(/127\.0\.0\.1:8787/, (r) => r.abort());
  await page.goto('/#/watch');
  await page.getByPlaceholder('Playlist link').fill('https://big.test/big.m3u');
  await page.getByRole('button', { name: 'Add link' }).click();
}

const railGroups = (page: Page) => page.locator('.railItem[data-group*="|"]');
/** The rail folds groups by country (home country open): open them all to count groups. */
async function openAllCountries(page: Page) {
  for (let i = 0; i < 60; i++) {
    const closed = page.locator('.railFold[aria-expanded="false"]').first();
    if (!(await closed.count())) return;
    await closed.click();
  }
}

test('big playlist: pick US + Sports, duplicates merged with a quality picker, hide a group, renumber', async ({ page }) => {
  test.setTimeout(90_000);
  await addBig(page);

  // 1. "Choose your channels" opens by itself for a big playlist.
  const dlg = page.getByRole('dialog', { name: 'Choose your channels' });
  await expect(dlg).toBeVisible({ timeout: 30_000 });
  await expect(dlg).toContainText('6,000');
  const us = dlg.getByRole('group', { name: 'Countries' }).getByRole('button', { name: /United States/ });
  await expect(us).toHaveAttribute('aria-pressed', 'true'); // locale country preselected
  const cats = dlg.getByRole('group', { name: 'Categories' });
  await expect(cats.getByRole('button', { name: /^Sports/ })).toHaveAttribute('aria-pressed', 'true');
  for (const c of ['News', 'Locals', 'Entertainment']) await cats.getByRole('button', { name: new RegExp(`^${c}`) }).click();
  await dlg.getByRole('button', { name: /^Show \d+ channels/ }).click();
  await expect(dlg).toBeHidden();

  // 2. Only US Sports is shown: one group in the rail, every row is a US channel.
  await expect(railGroups(page)).toHaveCount(1);
  await expect(railGroups(page).first()).toHaveAttribute('data-group', 'US|Sports');
  const rows = page.locator('.channels > button');
  const n = await rows.count();
  expect(n).toBeGreaterThan(5);
  expect(n).toBeLessThan(40);
  await expect(page.locator('.channels .ccBadge').filter({ hasNotText: 'US' })).toHaveCount(0);

  // 3. Duplicates appear once ("US| TSN 1", "US| TSN 1 FHD", "US| TSN 1 4K"… → "TSN 1" ×N).
  const merged = rows.filter({ has: page.locator('.qBadge', { hasText: '×' }) }).first();
  const name = (await merged.locator('.lnName b').innerText()).trim();
  expect(name).not.toMatch(/^US\||\b(HD|FHD|4K|HEVC|Backup)\b/);
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const espn = rows.filter({ has: page.locator('.lnName b', { hasText: exact }) });
  await expect(espn).toHaveCount(1);
  await espn.click();
  await expect(page.locator('.now h2')).toHaveText(name);

  // ...with a Quality picker; the choice is remembered.
  await page.locator('.now .qualityBtn').click();
  const menu = page.getByRole('menu', { name: 'Quality' });
  const items = menu.getByRole('menuitemradio');
  expect(await items.count()).toBeGreaterThan(1);
  await expect(items.first()).toHaveAttribute('aria-checked', 'true');
  const second = (await items.nth(1).innerText()).trim();
  await items.nth(1).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('.now .qualityBtn')).toContainText(second.split('\n')[0]);
  await page.locator('.now .qualityBtn').click();
  await expect(menu.getByRole('menuitemradio').nth(1)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // 4. Settings → Channels: show US News, hide US Sports.
  await page.goto('/#/settings/channels');
  await page.getByRole('checkbox', { name: 'Show US · News' }).check();
  await page.getByRole('checkbox', { name: 'Show US · Sports' }).uncheck();
  await page.goto('/#/watch');
  await expect(railGroups(page)).toHaveCount(1);
  await expect(railGroups(page).first()).toHaveAttribute('data-group', 'US|News');
  await expect(page.locator('.channels .lnName b', { hasText: exact })).toHaveCount(0);

  // 5. Renumber 1, 2, 3… in the visible order; number entry uses the new numbers.
  await page.goto('/#/settings/channels');
  await page.getByRole('switch', { name: 'Renumber channels' }).click();
  await page.goto('/#/watch');
  await page.locator('.railItem[data-group="all"]').click();
  await expect(page.locator('.channels > button .lnNum').first()).toHaveText('1');
  await expect(page.locator('.channels > button .lnNum').nth(1)).toHaveText('2');
  const second2 = (await page.locator('.channels > button').nth(1).locator('.lnName b').innerText()).trim();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('2');
  await expect(page.locator('.now h2')).toHaveText(second2, { timeout: 5000 });
  await expect(page.locator('.now > small')).toContainText('CH 2');
});

test('picker can be skipped and reopened from Live TV; "Show everything" keeps all groups', async ({ page }) => {
  test.setTimeout(90_000);
  await addBig(page);
  const dlg = page.getByRole('dialog', { name: 'Choose your channels' });
  await expect(dlg).toBeVisible({ timeout: 30_000 });
  await dlg.getByRole('button', { name: 'Close' }).click();
  await expect(dlg).toBeHidden();
  // Way fewer groups than the playlist's ~340 raw groups, and no duplicate rows.
  await openAllCountries(page);
  const groups = await railGroups(page).count();
  expect(groups).toBeGreaterThan(20);
  expect(groups).toBeLessThan(120);
  await expect(page.locator('.lineupTitle small')).toContainText('duplicates merged');
  await page.reload();
  await expect(page.locator('.channels > button').first()).toBeVisible({ timeout: 30_000 });
  await expect(dlg).toBeHidden(); // not nagging again
  await page.getByRole('button', { name: 'Choose channels' }).click();
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Show everything' }).click();
  await openAllCountries(page);
  await expect(railGroups(page)).toHaveCount(groups);
});

test('sports rail lists every sport and filters by sport; light theme switches the whole app', async ({ page }) => {
  test.setTimeout(90_000);
  await addBig(page);
  const dlg = page.getByRole('dialog', { name: 'Choose your channels' });
  await expect(dlg).toBeVisible({ timeout: 30_000 });
  await dlg.getByRole('button', { name: 'Show everything' }).click();

  // Every sport has a row; ones without channels are greyed out (disabled).
  const sports = page.locator('.railItem[data-group^="sport:"]');
  await expect(sports).toHaveCount(16);
  await expect(page.locator('.railItem[data-group="sport:tennis"]')).toBeDisabled();
  await page.locator('.railItem[data-group="sport:football"]').click();
  await expect(page.locator('.lineupTitle b')).toContainText('Football');
  const names = await page.locator('.channels > button .lnName b').allInnerTexts();
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) expect(n).toMatch(/NFL|Red ?Zone/i);

  // The Sports section folds away.
  await page.getByRole('button', { name: /^SPORTS/ }).click();
  await expect(sports).toHaveCount(0);

  // Light theme.
  await page.goto('/#/settings/appearance');
  await page.getByRole('button', { name: 'light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(243, 244, 247)');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

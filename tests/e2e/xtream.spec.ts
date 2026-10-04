import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Xtream Codes login: player_api.php mocked from tests/fixtures/xtream.json (no real provider). */
const fx = JSON.parse(readFileSync(resolve('tests/fixtures/xtream.json'), 'utf8'));
const cors = { 'access-control-allow-origin': '*' };

test('settings: log in with Xtream Codes, channels + movies load, password never shown', async ({ page }) => {
  await page.route('https://site.api.espn.com/**', (r) => r.fulfill({ json: { events: [], children: [] } }));
  await page.route('https://api.sleeper.app/**', (r) => r.fulfill({ status: 404, json: null }));
  await page.route('http://provider.test:8080/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('password') !== 's3cret!') return route.fulfill({ json: { user_info: { auth: 0 } }, headers: cors });
      return route.fulfill({ json: fx[u.searchParams.get('action') ?? 'auth'], headers: cors });
    }
    if (u.pathname === '/xmltv.php') return route.fulfill({ body: '<tv></tv>', contentType: 'application/xml', headers: cors });
    return route.abort();
  });
  await page.route(/logos\.test/, (r) => r.abort());

  await page.goto('/#/settings/sources');
  await page.getByRole('tab', { name: 'Xtream Codes login' }).click();
  // A pasted get.php link fills in the username and password.
  await page.getByLabel('Server').fill('http://provider.test:8080/get.php?username=fan&password=wrong&type=m3u_plus');
  await expect(page.getByLabel('Server')).toHaveValue('http://provider.test:8080');
  await expect(page.getByLabel('Username')).toHaveValue('fan');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.locator('.addPlaylist .err')).toContainText('Login failed');

  await page.getByLabel('Password').fill('s3cret!');
  await page.getByRole('button', { name: 'Log in' }).click();
  const row = page.locator('.srcRow').filter({ hasText: 'provider.test' }).first();
  await expect(row).toContainText('Xtream Codes', { timeout: 10_000 });
  await expect(row).toContainText('2 connections');
  await expect(row).toContainText('6 channels', { timeout: 10_000 });
  // The guide link is added from the account, redacted.
  await expect(page.locator('.panel[aria-label="Guide data"]')).toContainText('xmltv.php');
  await expect(page.locator('body')).not.toContainText('s3cret');

  await page.goto('/#/watch');
  await expect(page.locator('.channels')).toContainText('ESPN', { timeout: 10_000 });
  await expect(page.locator('.channels')).toContainText('CNN');

  // Backup: logins are left out unless included.
  await page.goto('/#/settings/backup');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export settings' }).click()]);
  const text = readFileSync(await download.path(), 'utf8');
  expect(text).not.toContain('s3cret');
  expect(text).toContain('"maxConnections": 2');
});

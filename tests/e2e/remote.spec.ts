import { test, expect, type Page } from '@playwright/test';

/**
 * Remote Control (desktop only). The web build has no desktop shell, so these tests install a
 * fake `window.dialDesktop.remote` bridge: it records what the app publishes and lets the test
 * fire phone commands, the same way the preload delivers them from the LAN server.
 */
const PLAYLIST = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="news.us" group-title="News",Dial News',
  'https://live.test/news.m3u8',
  '#EXTINF:-1 tvg-id="sports.us" group-title="Sports",Dial Sports',
  'https://live.test/sports.m3u8',
].join('\n');

function fakeBridge() {
  type Status = { enabled: boolean; on: boolean; port: number; url: string | null; urls: string[]; code: string | null; devices: { id: string; name: string; created: number; lastSeen: number; connected?: boolean }[]; error: string | null };
  const w = window as unknown as Record<string, unknown>;
  let status: Status = { enabled: false, on: false, port: 0, url: null, urls: [], code: null, devices: [{ id: 'd1', name: 'Andrew’s iPhone', created: Date.now(), lastSeen: Date.now(), connected: true }], error: null };
  const cmdListeners: ((c: unknown) => void)[] = [];
  const published: unknown[] = [];
  w.__remote = { published, fire: (c: unknown) => cmdListeners.forEach((l) => l(c)) };
  w.dialDesktop = {
    platform: 'win32',
    setMiniPlayer: async () => false,
    version: async () => '0.0.0-test',
    remote: {
      status: async () => status,
      setEnabled: async (on: boolean) => {
        status = on ? { ...status, enabled: true, on: true, port: 47800, url: 'http://192.168.1.42:47800/', urls: ['http://192.168.1.42:47800/'], code: '493017' } : { ...status, enabled: false, on: false, url: null, urls: [], code: null };
        return status;
      },
      revoke: async (id: string) => { status = { ...status, devices: status.devices.filter((d) => d.id !== id) }; return status; },
      newCode: async () => { status = { ...status, code: '000123' }; return status; },
      publish: (s: unknown) => { published.push(s); },
      onCommand: (cb: (c: unknown) => void) => { cmdListeners.push(cb); return () => cmdListeners.splice(cmdListeners.indexOf(cb), 1); },
      onStatus: () => () => {},
    },
  };
}

async function mock(page: Page) {
  await page.route('https://site.api.espn.com/**', (r) => r.fulfill({ json: { events: [], children: [] } }));
  await page.route('https://api.sleeper.app/**', (r) => r.fulfill({ status: 404, json: null }));
  await page.route('https://playlist.test/**', (r) => r.fulfill({ body: PLAYLIST, headers: { 'access-control-allow-origin': '*' } }));
  await page.route(/live\.test/, (r) => r.abort());
}

test('web build has no Remote settings tab', async ({ page }) => {
  await mock(page);
  await page.goto('/#/settings');
  await expect(page.getByRole('button', { name: 'Parental' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remote', exact: true })).toHaveCount(0);
});

test('desktop: turn on the phone remote, see QR + code, remove a phone', async ({ page }) => {
  await page.addInitScript(fakeBridge);
  await mock(page);
  await page.goto('/#/settings/remote');
  await expect(page.getByRole('heading', { name: 'Remote control' })).toBeVisible();
  await expect(page.getByText(/Windows Firewall asks/)).toBeVisible();
  await expect(page.locator('.qrCode')).toHaveCount(0);
  await page.getByRole('switch', { name: 'Phone remote' }).click();
  await expect(page.getByTestId('remote-url')).toHaveText('http://192.168.1.42:47800/');
  await expect(page.getByTestId('remote-code')).toHaveText('493017');
  await expect(page.locator('.qrCode path')).toHaveAttribute('d', /^M4 4h1v1h-1z/);
  await page.getByRole('button', { name: 'New code' }).click();
  await expect(page.getByTestId('remote-code')).toHaveText('000123');
  await expect(page.locator('.remoteDevice')).toContainText('Connected');
  await page.locator('.remoteDevice').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('No phones paired yet.')).toBeVisible();
  await page.getByRole('switch', { name: 'Phone remote' }).click();
  await expect(page.locator('.qrCode')).toHaveCount(0);
});

test('desktop: phone commands tune Live TV and now-playing is pushed back', async ({ page }) => {
  await page.addInitScript(fakeBridge);
  await mock(page);
  await page.goto('/#/watch');
  await page.getByPlaceholder('Playlist link').fill('https://playlist.test/tv.m3u');
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.locator('.channels > button')).toHaveCount(2, { timeout: 10_000 });
  const first = (await page.locator('.now h2').textContent())!;
  const other = first === 'Dial News' ? 'Dial Sports' : 'Dial News';
  const fire = (c: unknown) => page.evaluate((cmd) => (window as unknown as { __remote: { fire(c: unknown): void } }).__remote.fire(cmd), c);
  const lastPublished = () => page.evaluate(() => {
    const p = (window as unknown as { __remote: { published: { channel?: { name: string }; favorites: unknown[] }[] } }).__remote.published;
    return p[p.length - 1];
  });

  await fire({ type: 'chdown' });
  await expect(page.locator('.now h2')).toHaveText(other);
  await expect.poll(async () => (await lastPublished())?.channel?.name).toBe(other);
  await fire({ type: 'last' });
  await expect(page.locator('.now h2')).toHaveText(first);

  // From another page: the command opens Live TV and still runs.
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await fire({ type: 'chup' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Live TV');
  await expect(page.locator('.now h2')).toHaveText(other);

  await fire({ type: 'guide' });
  await expect(page.locator('.tvGuideOpen')).toBeVisible();
  await fire({ type: 'guide' });
  await expect(page.locator('.tvGuideOpen')).toHaveCount(0);

  // Favorites are listed for the phone.
  await page.locator('.now').getByRole('button', { name: 'Favorite' }).click();
  await expect.poll(async () => (await lastPublished())?.favorites.length).toBe(1);
});

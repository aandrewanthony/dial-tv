import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPersisted, hydrate, migrate, SCHEMA_VERSION, useApp, type PersistedState } from '../../src/store/app';
import { kv } from '../../src/store/db';
import {
  exportablePersisted, KEYCHAIN_READ_ERROR, mergeImportedSecrets, needsSeal, NOT_IN_BACKUP_ERROR, openChannels, openPersisted,
  resetSourceSecrets, sealChannels, sealPersisted, secretNameFor,
} from '../../src/store/sourceSecrets';
import type { Channel, EpgSource, PlaylistSource } from '../../src/types';

const M3U_URL = 'http://provider.test:8080/get.php?username=fan&password=s3cret!&type=m3u_plus';
const EPG_URL = 'http://provider.test:8080/xmltv.php?username=fan&password=s3cret!';
const playlists: PlaylistSource[] = [
  { id: 'pl1', name: 'Provider M3U', kind: 'm3u-url', url: M3U_URL, enabled: true, lastLoaded: 1, channelCount: 2 },
  { id: 'm3u2', name: 'file.m3u', kind: 'm3u-file', enabled: true, lastLoaded: 1, channelCount: 1 },
  { id: 'xc3', name: 'Xtream', kind: 'xtream', xtream: { server: 'http://provider.test:8080', username: 'fan', password: 's3cret!', output: 'auto' }, account: { status: 'Active', maxConnections: 2 }, maxConnections: 2, enabled: true, lastLoaded: 1, channelCount: 1 },
];
const epgSources: EpgSource[] = [
  { id: 'epg-pl1', name: 'Provider guide', kind: 'xmltv-url', url: EPG_URL, enabled: true },
  { id: 'x2', name: 'guide.xml', kind: 'xmltv-file', enabled: true },
];
const v5 = () => ({ ...defaultPersisted(), version: 5, playlists, epgSources, favorites: ['pl1:espn.us'], dismissedEpgUrls: [EPG_URL.replace('fan', 'other')] });

/** Fake desktop keychain (window.dialDesktop.secrets, like electron/preload.cjs). */
let keychain: Map<string, string>;
let keychainWorks = true;
function installDesktop() {
  keychain = new Map();
  keychainWorks = true;
  (window as unknown as { dialDesktop: unknown }).dialDesktop = {
    platform: 'win32',
    setMiniPlayer: async () => true,
    version: async () => '0.7.0',
    secrets: {
      get: async (n: string) => keychain.get(n) ?? null,
      set: async (n: string, v: string | null) => {
        if (!keychainWorks) return false;
        if (v == null) keychain.delete(n);
        else keychain.set(n, v);
        return true;
      },
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetSourceSecrets());
afterEach(() => {
  delete (window as unknown as { dialDesktop?: unknown }).dialDesktop;
});

describe('schema v6 migration', () => {
  it('keeps existing playlists exactly (lossless) and redacts remembered dismissed guide links', () => {
    const m = migrate(v5());
    expect(SCHEMA_VERSION).toBe(6);
    expect(m.version).toBe(6);
    expect(m.playlists).toEqual(playlists);
    expect(m.epgSources).toEqual(epgSources);
    expect(m.favorites).toEqual(['pl1:espn.us']);
    expect(m.dismissedEpgUrls).toHaveLength(1);
    expect(m.dismissedEpgUrls[0]).not.toContain('s3cret');
    expect(migrate(m)).toEqual(m); // idempotent
  });
});

describe('playlist logins in the OS keychain (desktop)', () => {
  it('web: saved as before', async () => {
    const s = migrate(v5());
    expect(needsSeal(s)).toBe(false);
    expect(await sealPersisted(s)).toBe(s);
  });

  it('desktop: saved copy has no logins; loading restores them exactly', async () => {
    installDesktop();
    const s = migrate(v5());
    expect(needsSeal(s)).toBe(true);
    const sealed = await sealPersisted(s);
    const json = JSON.stringify(sealed);
    expect(json).not.toContain('s3cret');
    expect(json).not.toContain('get.php');
    const { url: _u, ...rest } = playlists[0];
    expect(sealed.playlists[0]).toStrictEqual({ ...rest, keychain: true });
    expect(sealed.playlists[1]).toEqual(playlists[1]); // local file: nothing secret
    expect(sealed.playlists[2].xtream).toEqual({ server: 'http://provider.test:8080', username: 'fan', output: 'auto' });
    expect(sealed.playlists[2].maxConnections).toBe(2);
    expect(sealed.epgSources[0].keychain).toBe(true);
    expect(keychain.size).toBe(3);
    expect([...keychain.keys()].every((k) => /^[a-z0-9_-]{1,40}$/.test(k))).toBe(true);
    expect(needsSeal(sealed)).toBe(false);

    resetSourceSecrets(); // a new app session
    const opened = await openPersisted(sealed);
    expect(opened.playlists).toEqual(playlists);
    expect(opened.epgSources).toEqual(epgSources);
  });

  it('only rewrites changed logins and deletes the entry of a removed playlist', async () => {
    installDesktop();
    const s = migrate(v5());
    await sealPersisted(s);
    const writes: string[] = [];
    const bridge = (window as unknown as { dialDesktop: { secrets: { set: (n: string, v: string | null) => Promise<boolean> } } }).dialDesktop.secrets;
    const orig = bridge.set;
    bridge.set = async (n, v) => { writes.push(`${n}=${v ? 'set' : 'del'}`); return orig(n, v); };
    await sealPersisted(s);
    expect(writes).toEqual([]);
    await sealPersisted({ ...s, playlists: s.playlists.filter((p) => p.id !== 'xc3') });
    await flush();
    expect(writes).toEqual([`${secretNameFor('xc3')}=del`]);
    expect(keychain.has(secretNameFor('xc3'))).toBe(false);
  });

  it('keychain write fails: keeps the login in the saved copy (never lost)', async () => {
    installDesktop();
    keychainWorks = false;
    const s = migrate(v5());
    const sealed = await sealPersisted(s);
    expect(sealed.playlists).toEqual(playlists);
    expect(sealed.epgSources).toEqual(epgSources);
  });

  it('keychain unreadable: keeps the marker (so the entry is not deleted) and shows an error', async () => {
    installDesktop();
    const sealed = await sealPersisted(migrate(v5()));
    keychain.delete(secretNameFor('xc3'));
    resetSourceSecrets();
    const opened = await openPersisted(sealed);
    expect(opened.playlists[0].url).toBe(M3U_URL);
    expect(opened.playlists[2]).toMatchObject({ keychain: true, error: KEYCHAIN_READ_ERROR });
    const again = await sealPersisted(opened);
    expect(again.playlists[2].keychain).toBe(true);
    expect(keychain.has(secretNameFor('pl1'))).toBe(true);
  });

  it('hydrate moves an existing v5 save into the keychain on desktop, and reads it back', async () => {
    installDesktop();
    const ch = (id: string, sourceId: string, url: string): Channel => ({ id, number: 1, name: id, group: 'g', mark: 'X', url, sourceId });
    const cached = [
      ch('xc3:a', 'xc3', 'http://provider.test:8080/live/fan/s3cret!/1.ts'),
      ch('pl1:b', 'pl1', 'http://provider.test:8080/fan/s3cret!/2'),
      ch('m3u2:c', 'm3u2', 'https://cdn.test/c.m3u8'),
    ];
    await kv.put('state', v5());
    await kv.set('cache:channels', cached);
    await hydrate();
    for (let i = 0; i < 5; i++) await flush();
    const saved = await kv.get<PersistedState>('state');
    expect(saved?.version).toBe(6);
    expect(JSON.stringify(saved)).not.toContain('s3cret');
    expect(JSON.stringify(await kv.get('cache:channels'))).not.toContain('s3cret');
    expect(useApp.getState().playlists).toEqual(playlists);
    expect(useApp.getState().channels).toEqual(cached);

    // Next start: everything comes back from the keychain.
    resetSourceSecrets();
    useApp.setState({ playlists: [], epgSources: [], channels: [] });
    await hydrate();
    expect(useApp.getState().playlists).toEqual(playlists);
    expect(useApp.getState().epgSources).toEqual(epgSources);
    expect(useApp.getState().channels).toEqual(cached);
    await kv.clear();
  });
});

describe('channel cache placeholders', () => {
  const ch = (id: string, sourceId: string, url: string, fallbackUrls?: string[]): Channel => ({ id, number: 1, name: id, group: 'g', mark: 'X', url, sourceId, ...(fallbackUrls ? { fallbackUrls } : {}) });
  const channels = [
    ch('a', 'xc3', 'http://provider.test:8080/live/fan/s3cret!/1.ts', ['http://backup.test/live/fan/s3cret!/1.m3u8']),
    ch('b', 'pl1', 'http://provider.test:8080/fan/s3cret!/2'),
    ch('c', 'm3u2', 'https://fan.test/fanfare.m3u8'),
  ];
  it('desktop: round-trips losslessly and hides the login; web: unchanged', () => {
    expect(sealChannels(channels, playlists)).toBe(channels);
    installDesktop();
    const sealed = sealChannels(channels, playlists);
    expect(JSON.stringify(sealed)).not.toContain('s3cret');
    expect(sealed[2]).toBe(channels[2]);
    expect(openChannels(sealed, playlists)).toEqual(channels);
    // Login no longer available: those channels are dropped instead of playing a broken URL.
    expect(openChannels(sealed, [playlists[1]]).map((c) => c.id)).toEqual(['c']);
  });
  it('hides URL-encoded passwords too', () => {
    installDesktop();
    const pl = [{ ...playlists[2], xtream: { ...playlists[2].xtream!, password: 'p@ss/w rd' } }];
    const enc = [ch('a', 'xc3', 'http://provider.test:8080/live/fan/p%40ss%2Fw%20rd/1.ts')];
    const sealed = sealChannels(enc, pl);
    expect(sealed[0].url).not.toContain('p%40ss');
    expect(openChannels(sealed, pl)).toEqual(enc);
  });
});

describe('settings export / import', () => {
  it('leaves logins out unless asked, and an import keeps this device’s logins', () => {
    const s = migrate(v5());
    const out = exportablePersisted({ ...s, playlists: s.playlists.map((p) => ({ ...p, keychain: undefined })) }, false);
    expect(JSON.stringify(out)).not.toContain('s3cret');
    expect(out.playlists[0].url).toBeUndefined();
    expect(out.playlists[2].xtream?.username).toBe('fan');
    expect(out.epgSources[0].url).toBeUndefined();
    expect(exportablePersisted(s, true).playlists).toEqual(playlists);

    const here = mergeImportedSecrets(migrate(out), s);
    expect(here.playlists).toEqual(playlists);
    const elsewhere = mergeImportedSecrets(migrate(out), { playlists: [], epgSources: [] });
    expect(elsewhere.playlists[0].error).toBe(NOT_IN_BACKUP_ERROR);
    expect(elsewhere.playlists[1].error).toBeUndefined();
    expect(elsewhere.playlists[2].error).toBe(NOT_IN_BACKUP_ERROR);
    expect(elsewhere.epgSources[0].error).toBe(NOT_IN_BACKUP_ERROR);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  liveExtension, mapXtream, parseAccount, parseXtreamServer, xtreamProvider, xtreamStreamUrl, xtreamXmltvUrl,
} from '../../src/providers/xtream';
import { orderedChannels } from '../../src/store/app';
import { redactUrl } from '../../src/lib/url';
import type { PlaylistSource } from '../../src/types';

const fx = JSON.parse(readFileSync(resolve('tests/fixtures/xtream.json'), 'utf8'));
const login = { server: 'http://provider.test:8080', username: 'fan', password: 's3cret!' };

describe('Xtream server input', () => {
  it('normalizes the server and picks the login out of a pasted link', () => {
    expect(parseXtreamServer('provider.test:8080')).toEqual({ server: 'http://provider.test:8080' });
    expect(parseXtreamServer('https://provider.test/')).toEqual({ server: 'https://provider.test' });
    expect(parseXtreamServer('http://provider.test:8080/player_api.php')).toEqual({ server: 'http://provider.test:8080' });
    expect(parseXtreamServer('http://provider.test:8080/get.php?username=fan&password=s3cret%21&type=m3u_plus&output=ts'))
      .toEqual({ server: 'http://provider.test:8080', username: 'fan', password: 's3cret!' });
    expect(parseXtreamServer('http://provider.test/sub/xmltv.php')).toEqual({ server: 'http://provider.test/sub' });
    expect(parseXtreamServer('ftp://provider.test')).toBeNull();
    expect(parseXtreamServer('javascript:alert(1)')).toBeNull();
    expect(parseXtreamServer('  ')).toBeNull();
  });
});

describe('Xtream account (user_info)', () => {
  it('reads expiry, connections and formats', () => {
    const a = parseAccount(fx.auth.user_info);
    expect(a).toEqual({
      status: 'Active', expiresAt: 1893456000 * 1000, maxConnections: 2, activeConnections: 1, isTrial: false, formats: ['m3u8', 'ts', 'rtmp'],
    });
    // null / "0" expiry = unlimited; numbers may arrive as numbers.
    expect(parseAccount({ status: 'Active', exp_date: null, max_connections: 1 })).toEqual({ status: 'Active', maxConnections: 1 });
    expect(parseAccount({ exp_date: '0' })).toEqual({});
    expect(parseAccount(undefined)).toEqual({});
  });

  it('picks the live container', () => {
    expect(liveExtension('auto', parseAccount(fx.auth.user_info))).toBe('ts');
    expect(liveExtension('auto', { formats: ['m3u8'] })).toBe('m3u8');
    expect(liveExtension(undefined, undefined)).toBe('ts');
    expect(liveExtension('m3u8', { formats: ['ts'] })).toBe('m3u8');
  });
});

describe('Xtream → channels', () => {
  const data = { liveCategories: fx.get_live_categories, live: fx.get_live_streams, vodCategories: fx.get_vod_categories, vod: fx.get_vod_streams };
  const channels = mapXtream('xc1', login, data, 200);

  it('maps live streams like an M3U playlist (ids, numbers, groups, guide ids, logos)', () => {
    const live = channels.filter((c) => !c.kind);
    expect(live.map((c) => c.name)).toEqual(['US| FOX SPORTS 1', 'US| ESPN FHD', 'US| CNN', 'US| CNN']); // provider order (num); entry without id skipped
    expect(live.map((c) => c.id)).toEqual(['xc1:fs1.us', 'xc1:espn.us', 'xc1:us| cnn', 'xc1:us| cnn#3']);
    expect(live.map((c) => c.number)).toEqual([200, 201, 202, 203]);
    expect(live.map((c) => c.group)).toEqual(['US| SPORTS', 'US| SPORTS', 'US| NEWS', 'Uncategorized']);
    expect(live[0]).toMatchObject({ sourceId: 'xc1', tvgId: 'FS1.us', mark: 'FS', url: 'http://provider.test:8080/live/fan/s3cret!/1001.ts' });
    expect(live[0].logo).toBeUndefined();
    expect(live[1].logo).toBe('http://logos.test/espn.png');
    expect(live[2].logo).toBeUndefined(); // javascript: rejected
    expect(live[2].tvgId).toBeUndefined();
  });

  it('builds standard stream URLs (ts / m3u8, movies with their container)', () => {
    expect(mapXtream('xc1', login, data, 200, 'm3u8')[0].url).toBe('http://provider.test:8080/live/fan/s3cret!/1001.m3u8');
    expect(xtreamStreamUrl({ ...login, password: 'a/b c' }, 'live', 7, 'ts')).toBe('http://provider.test:8080/live/fan/a%2Fb%20c/7.ts');
    expect(xtreamXmltvUrl(login)).toBe('http://provider.test:8080/xmltv.php?username=fan&password=s3cret!');
  });

  it('maps movies for Movies & Series', () => {
    const movies = channels.filter((c) => c.kind === 'movie');
    expect(movies).toHaveLength(2);
    expect(movies[0]).toMatchObject({ id: 'xc1:movie-5001', kind: 'movie', title: 'Heat', year: 1995, group: 'VOD | Action', url: 'http://provider.test:8080/movie/fan/s3cret!/5001.mkv' });
    expect(movies[1]).toMatchObject({ title: 'Ronin', url: 'http://provider.test:8080/movie/fan/s3cret!/5002.mp4' });
  });

  it('works with channel organization unchanged', () => {
    const ordered = orderedChannels({ channels, channelOrder: [], hidden: [] });
    expect(ordered.length).toBeGreaterThanOrEqual(3); // live only; duplicate CNN entries may merge
    expect(ordered.every((c) => !c.kind || c.kind === 'live')).toBe(true);
    expect(ordered.some((c) => c.tvgId === 'ESPN.us')).toBe(true);
  });

  it('never shows the login in redacted URLs', () => {
    for (const u of [channels[0].url, channels.find((c) => c.kind === 'movie')!.url, xtreamXmltvUrl(login)]) {
      const r = redactUrl(u);
      expect(r).not.toContain('s3cret');
      expect(r).not.toContain('fan');
    }
  });
});

describe('Xtream provider (player_api.php)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const src: PlaylistSource = { id: 'xc1', name: 'My provider', kind: 'xtream', xtream: { ...login, output: 'auto' }, enabled: true };

  it('logs in, loads live + movies and returns the guide link and account', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      calls.push(u.searchParams.get('action') ?? 'auth');
      expect(u.pathname).toBe('/player_api.php');
      expect(u.searchParams.get('password')).toBe('s3cret!');
      return new Response(JSON.stringify(fx[u.searchParams.get('action') ?? 'auth']));
    }));
    const r = await xtreamProvider(src, 500).load();
    expect(calls.sort()).toEqual(['auth', 'get_live_categories', 'get_live_streams', 'get_vod_categories', 'get_vod_streams']);
    expect(r.channels).toHaveLength(6);
    expect(r.channels[0].number).toBe(500);
    expect(r.epgUrl).toBe('http://provider.test:8080/xmltv.php?username=fan&password=s3cret!');
    expect(r.account.maxConnections).toBe(2);
  });

  it('keeps live TV when the movie list fails, and reports bad logins / expired accounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const action = new URL(url).searchParams.get('action') ?? 'auth';
      if (action.startsWith('get_vod')) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify(fx[action]));
    }));
    expect((await xtreamProvider(src, 500).load()).channels).toHaveLength(4);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user_info: { auth: 0 } }))));
    await expect(xtreamProvider(src, 500).load()).rejects.toThrow(/Login failed/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user_info: { auth: 1, status: 'Expired', exp_date: '1600000000' } }))));
    await expect(xtreamProvider(src, 500).load()).rejects.toThrow(/Account Expired/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not xtream</html>')));
    await expect(xtreamProvider(src, 500).load()).rejects.toThrow(/Xtream Codes server/);
    await expect(xtreamProvider({ ...src, xtream: undefined }, 500).load()).rejects.toThrow(/login is missing/);
  });
});

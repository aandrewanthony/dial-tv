import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pending = new Map<string, { resolve: (s: string) => void; reject: (e: Error) => void }[]>();
vi.mock('../../src/lib/net', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lib/net')>();
  return {
    ...orig,
    fetchText: vi.fn(
      (url: string) =>
        new Promise<string>((resolve, reject) => {
          const arr = pending.get(url) ?? [];
          arr.push({ resolve, reject });
          pending.set(url, arr);
        }),
    ),
  };
});

import { dedupeChannelNumbers, defaultPersisted, hydrate, migrate, nowPlaying, programsByChannel, SCHEMA_VERSION, STORAGE_READ_ERROR, useApp } from '../../src/store/app';
import { kv } from '../../src/store/db';
import type { Channel, PlaylistSource, Program } from '../../src/types';

const m3u = (names: string[], epg?: string, chno?: number) =>
  ['#EXTM3U' + (epg ? ` url-tvg="${epg}"` : ''), ...names.flatMap((n) => [`#EXTINF:-1${chno != null ? ` tvg-chno="${chno}"` : ''},${n}`, `https://cdn.example/${encodeURIComponent(n)}.m3u8`])].join('\n');

const flush = () => new Promise((r) => setTimeout(r, 0));
async function respond(url: string, body: string) {
  for (let i = 0; i < 50 && !pending.get(url)?.length; i++) await flush();
  const p = pending.get(url)?.shift();
  if (!p) throw new Error(`no pending fetch for ${url}`);
  p.resolve(body);
  await flush();
}

const pl = (id: string, enabled = true): PlaylistSource => ({ id, name: id, kind: 'm3u-url', url: `https://pl/${id}.m3u`, enabled });

beforeEach(() => {
  pending.clear();
  useApp.setState({ ...defaultPersisted(), channels: [], programs: [], loadingSources: false, currentId: undefined });
});
afterEach(() => vi.restoreAllMocks());

describe('loadSources', () => {
  it('does not resurrect a playlist removed during a load, and keeps one added during it', async () => {
    useApp.setState({ playlists: [pl('a'), pl('b')] });
    const done = useApp.getState().loadSources();
    await respond('https://pl/a.m3u', m3u(['A1']));
    // While b is loading: remove a, add c.
    useApp.getState().update((s) => ({ playlists: [...s.playlists.filter((p) => p.id !== 'a'), pl('c')] }));
    const again = useApp.getState().loadSources(); // coalesced: resolves after a follow-up pass
    expect(again).toBe(done);
    await respond('https://pl/b.m3u', m3u(['B1']));
    // follow-up pass loads b and c
    await respond('https://pl/b.m3u', m3u(['B1']));
    await respond('https://pl/c.m3u', m3u(['C1']));
    await done;
    const s = useApp.getState();
    expect(s.playlists.map((p) => p.id)).toEqual(['b', 'c']);
    expect(s.playlists.every((p) => p.channelCount === 1)).toBe(true);
    expect(s.channels.map((c) => c.name).sort()).toEqual(['B1', 'C1']);
    expect(s.loadingSources).toBe(false);
  });

  it('drops channels of a playlist disabled mid-load (no follow-up call needed)', async () => {
    useApp.setState({ playlists: [pl('a'), pl('b')] });
    const done = useApp.getState().loadSources();
    await respond('https://pl/a.m3u', m3u(['A1']));
    useApp.getState().update((s) => ({ playlists: s.playlists.map((p) => (p.id === 'a' ? { ...p, enabled: false } : p)) }));
    await respond('https://pl/b.m3u', m3u(['B1']));
    await done;
    const s = useApp.getState();
    expect(s.channels.map((c) => c.name)).toEqual(['B1']);
    expect(s.playlists.find((p) => p.id === 'a')).toMatchObject({ enabled: false, channelCount: 1 });
  });

  it('auto-discovers a playlist guide once and never re-adds a dismissed one', async () => {
    useApp.setState({ playlists: [pl('a')] });
    let done = useApp.getState().loadSources();
    await respond('https://pl/a.m3u', m3u(['A1'], 'https://g/guide.xml'));
    await respond('https://g/guide.xml', '<tv></tv>');
    await done;
    expect(useApp.getState().epgSources.map((e) => e.id)).toEqual(['epg-a']);

    done = useApp.getState().removeEpgSource('epg-a');
    await respond('https://pl/a.m3u', m3u(['A1'], 'https://g/guide.xml'));
    await done;
    expect(useApp.getState().epgSources).toEqual([]);
    expect(useApp.getState().dismissedEpgUrls).toEqual(['https://g/guide.xml']);
  });

  it('remaps channel numbers that collide across playlists', async () => {
    useApp.setState({ playlists: [pl('a'), pl('b')] });
    const done = useApp.getState().loadSources();
    await respond('https://pl/a.m3u', m3u(['A1'], undefined, 7));
    await respond('https://pl/b.m3u', m3u(['B1', 'B2'], undefined, 7));
    await done;
    const nums = useApp.getState().channels.map((c) => c.number);
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums[0]).toBe(7);
  });
});

describe('dedupeChannelNumbers', () => {
  const ch = (id: string, number: number) => ({ id, number, name: id, group: '', mark: '', url: 'https://x', sourceId: 's' }) as Channel;
  it('keeps first, moves duplicates to the next free number, stable for same input', () => {
    const input = [ch('a', 5), ch('b', 6), ch('c', 5), ch('d', 5)];
    const out = dedupeChannelNumbers(input);
    expect(out.map((c) => c.number)).toEqual([5, 6, 7, 8]);
    expect(dedupeChannelNumbers(input).map((c) => c.number)).toEqual([5, 6, 7, 8]);
    const clean = [ch('a', 1), ch('b', 2)];
    expect(dedupeChannelNumbers(clean)).toBe(clean);
  });
});

describe('persistence v4 and hydrate', () => {
  it('migrates v3 to v4 with dismissedEpgUrls', () => {
    const m = migrate({ version: 3, playlists: [] });
    expect(SCHEMA_VERSION).toBe(4);
    expect(m.dismissedEpgUrls).toEqual([]);
    expect(migrate({ version: 4, dismissedEpgUrls: ['u'] }).dismissedEpgUrls).toEqual(['u']);
  });

  it('on a failed read keeps saved data untouched and does not auto-save', async () => {
    await kv.put('state', { ...defaultPersisted(), favorites: ['real'] });
    const get = vi.spyOn(kv, 'get').mockRejectedValue(new Error('boom'));
    const put = vi.spyOn(kv, 'put');
    await hydrate();
    expect(get).toHaveBeenCalledTimes(3); // state twice (retry) + cached channels
    expect(useApp.getState().storageError).toBe(STORAGE_READ_ERROR);
    useApp.getState().set({ favorites: ['x'] });
    await flush();
    expect(put).not.toHaveBeenCalledWith('state', expect.anything());
    get.mockRestore();
    expect((await kv.get<{ favorites: string[] }>('state'))?.favorites).toEqual(['real']);
  });

  it('surfaces a write failure as storageError instead of falling back', async () => {
    vi.spyOn(kv, 'put').mockRejectedValue(new Error('quota'));
    await hydrate();
    useApp.getState().set({ favorites: ['y'] });
    await flush();
    await flush();
    expect(useApp.getState().storageError).toMatch(/Could not save/);
  });
});

describe('programsByChannel / nowPlaying', () => {
  const p = (ch: string, s: number, e: number): Program => ({ id: `${ch}|${s}`, channelId: ch, title: `${ch}${s}`, start: s, end: e, category: '' });
  it('indexes once per array and finds the airing program', () => {
    const programs = [p('a', 20, 30), p('a', 0, 10), p('a', 10, 20), p('b', 0, 100)];
    const idx = programsByChannel(programs);
    expect(programsByChannel(programs)).toBe(idx);
    expect(idx.get('a')!.map((x) => x.start)).toEqual([0, 10, 20]);
    expect(nowPlaying(programs, 'a', 15)?.start).toBe(10);
    expect(nowPlaying(programs, 'a', 30)).toBeUndefined();
    expect(nowPlaying(programs, 'b', 50)?.channelId).toBe('b');
    expect(nowPlaying(programs, 'zz', 5)).toBeUndefined();
  });
});

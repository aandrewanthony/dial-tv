import { describe, expect, it, vi } from 'vitest';
import { defaultPersisted, migrate, orderedChannels, SCHEMA_VERSION } from '../../src/store/app';
import { kv } from '../../src/store/db';
import { sleeperProvider } from '../../src/providers/sleeper';
import type { Channel } from '../../src/types';

describe('persistence', () => {
  it('migrates empty / v0 / v1 state to current schema with defaults', () => {
    expect(migrate(undefined)).toEqual(defaultPersisted());
    const v1 = migrate({ version: 1, favorites: ['a'], leagues: [], settings: { spoilerShield: true } });
    expect(v1.version).toBe(SCHEMA_VERSION);
    expect(v1.favorites).toEqual(['a']);
    expect(v1.leagues.length).toBeGreaterThan(0);
    expect(v1.pickPlayers).toEqual(['Me', 'Bro']);
    expect(v1.settings.spoilerShield).toBe(true);
    expect(v1.settings.guideZoom).toBe(60);
  });

  it('round-trips through IndexedDB', async () => {
    await kv.set('k', { a: 1 });
    expect(await kv.get('k')).toEqual({ a: 1 });
    await kv.del('k');
    expect(await kv.get('k')).toBeUndefined();
  });

  it('orders channels by custom order then number, hiding hidden', () => {
    const ch = (id: string, number: number) => ({ id, number, name: id, group: '', mark: '', url: 'https://x', sourceId: 's' }) as Channel;
    const channels = [ch('a', 3), ch('b', 1), ch('c', 2)];
    expect(orderedChannels({ channels, channelOrder: [], hidden: [] }).map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(orderedChannels({ channels, channelOrder: ['a'], hidden: ['c'] }).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('Sleeper adapter', () => {
  it('builds my matchup and opponent from league endpoints', async () => {
    const routes: Record<string, unknown> = {
      '/league/L/rosters': [{ roster_id: 1, owner_id: 'u1', starters: ['p1'] }, { roster_id: 2, owner_id: 'u2', starters: ['p2'] }],
      '/league/L/users': [{ user_id: 'u1', display_name: 'me', metadata: { team_name: 'Gridiron' } }, { user_id: 'u2', display_name: 'bro' }],
      '/league/L/matchups/5': [
        { roster_id: 1, matchup_id: 3, points: 88.4, starters: ['p1', '0'], players_points: { p1: 20.5 } },
        { roster_id: 2, matchup_id: 3, points: 91.2, starters: ['p2'], players_points: { p2: 30 } },
      ],
    };
    const fetchMock = vi.fn(async (url: string) => {
      const path = url.replace('https://api.sleeper.app/v1', '');
      return new Response(JSON.stringify(routes[path] ?? null), { status: routes[path] ? 200 : 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const m = await sleeperProvider.matchup('L', 'u1', 5);
    expect(m.me).toMatchObject({ teamName: 'Gridiron', points: 88.4, starters: ['p1'] });
    expect(m.opponent).toMatchObject({ ownerName: 'bro', teamName: 'bro', points: 91.2 });
    await expect(sleeperProvider.matchup('L', 'nobody', 5)).rejects.toThrow(/roster/);
    vi.unstubAllGlobals();
  });
});

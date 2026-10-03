import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleeperProvider } from '../../src/providers/sleeper';
import { resetFantasyCaches, useFantasy } from '../../src/store/fantasy';
import { useApp } from '../../src/store/app';

afterEach(() => vi.restoreAllMocks());

describe('fantasy refresh', () => {
  it('re-runs when the config changes mid-load and caches leagues per user+season', async () => {
    resetFantasyCaches();
    vi.spyOn(sleeperProvider, 'currentWeek').mockResolvedValue({ week: 5, season: '2026' });
    vi.spyOn(sleeperProvider, 'players').mockResolvedValue({});
    const leagues = vi.spyOn(sleeperProvider, 'leagues').mockImplementation(async (userId) => [{ id: `L-${userId}`, name: userId, season: '2026' }]);
    vi.spyOn(sleeperProvider, 'matchup').mockImplementation(async (leagueId, userId, week) => ({
      week, me: { rosterId: 1, ownerName: userId, teamName: leagueId, starters: [], points: 0, playerPoints: {} },
    }));
    useApp.setState({ fantasy: { provider: 'sleeper', username: 'a', userId: 'u1', displayName: 'a', leagueId: 'L1' } });
    const p = useFantasy.getState().refresh();
    // Switch user while the first load is running.
    useApp.setState({ fantasy: { provider: 'sleeper', username: 'b', userId: 'u2', displayName: 'b', leagueId: 'L2' } });
    expect(useFantasy.getState().refresh()).toBe(p);
    await p;
    const s = useFantasy.getState();
    expect(s.matchup?.me.ownerName).toBe('u2');
    expect(s.leagues.map((l) => l.id)).toEqual(['L-u2']);
    expect(s.loading).toBe(false);
    await useFantasy.getState().refresh();
    expect(leagues.mock.calls.filter(([u]) => u === 'u2')).toHaveLength(1); // cached for u2|2026
  });
});

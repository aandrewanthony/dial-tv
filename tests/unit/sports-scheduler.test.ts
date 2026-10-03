import { describe, expect, it } from 'vitest';
import { autoTuneTarget, buildPlan, HOUR, MIN, planCandidates, planEntries } from '../../src/lib/scheduler';
import type { ScheduleEntry, SportEvent } from '../../src/types';

const T0 = Date.UTC(2026, 9, 4, 17); // Sunday 1 PM ET
const game = (id: string, home: string, away: string, start: number, o: Partial<SportEvent> = {}): SportEvent => ({
  id: `nfl:${id}`, league: 'nfl', start, state: 'pre', statusText: '', period: 0, broadcasts: ['CBS'],
  home: { id: home, abbr: home, name: home, shortName: home }, away: { id: away, abbr: away, name: away, shortName: away }, ...o,
});

describe('Smart Schedule planning', () => {
  const games = [
    game('1', 'BUF', 'NE', T0), // my team
    game('2', 'CHI', 'NYJ', T0), // fantasy
    game('3', 'KC', 'LV', T0 + 3.4 * HOUR, { broadcasts: ['KSHB'] }), // nothing personal, local TV
    game('4', 'DAL', 'PHI', T0 + 7.3 * HOUR, { broadcasts: ['NBC'], odds: { provider: 'X', spread: 2.5 } }), // national + close line
    game('5', 'MIA', 'NYG', T0, { state: 'post' }),
  ];
  const input = {
    from: T0 - HOUR, to: T0 + 12 * HOUR, games, schedule: [] as ScheduleEntry[], favTeams: ['nfl:BUF'],
    stakes: new Map([['nfl:2', { mine: 2, theirs: 1 }]]),
  };

  it('collects and ranks candidates: my team > fantasy > national; skips finals and non-stakes', () => {
    const c = planCandidates(input);
    expect(c.map((x) => x.id)).toEqual(['game:nfl:1', 'game:nfl:2', 'game:nfl:4']);
    expect(c[0]).toMatchObject({ tier: 'team', reasons: ['Your team'] });
    expect(c[1].tier).toBe('fantasy');
    expect(c[2].tier).toBe('national');
    expect(planCandidates({ ...input, includeOther: false }).map((x) => x.id)).not.toContain('game:nfl:4');
  });

  it('proposes one pick per slot with conflicts going to Multiview', () => {
    const slots = buildPlan(planCandidates(input));
    expect(slots[0]).toMatchObject({ start: T0, conflict: true });
    expect(slots[0].primary.id).toBe('game:nfl:1');
    expect(slots[0].also.map((x) => x.id)).toEqual(['game:nfl:2']);
    expect(slots[slots.length - 1].primary.id).toBe('game:nfl:4');
    expect(slots[slots.length - 1].conflict).toBe(false);
  });

  it('pinned and hand-scheduled items win; skipped items disappear; bets count', () => {
    const pinned = buildPlan(planCandidates({ ...input, pinned: ['game:nfl:2'] }));
    expect(pinned[0].primary.id).toBe('game:nfl:2');
    const skipped = planCandidates({ ...input, skipped: ['game:nfl:1'] });
    expect(skipped.map((x) => x.id)).not.toContain('game:nfl:1');
    const show: ScheduleEntry = { id: 'custom:1', title: 'Movie night', start: T0 + HOUR, end: T0 + 3 * HOUR };
    const withShow = buildPlan(planCandidates({ ...input, schedule: [show] }));
    expect(withShow.find((s) => s.start === T0 + HOUR)?.primary.id).toBe('custom:1');
    const bets = planCandidates({ ...input, betEvents: new Set(['nfl:3']) });
    expect(bets.find((x) => x.id === 'game:nfl:3')?.tier).toBe('bet');
  });

  it('sticks with the current pick until something strictly better starts', () => {
    const a = { id: 'a', title: 'A', start: 0, end: 10, tier: 'fantasy' as const, priority: 60, reasons: [] };
    const b = { id: 'b', title: 'B', start: 5, end: 15, tier: 'fantasy' as const, priority: 60, reasons: [] };
    const slots = buildPlan([a, b]);
    expect(slots.map((s) => [s.start, s.end, s.primary.id])).toEqual([[0, 10, 'a'], [10, 15, 'b']]);
    const c = { ...b, id: 'c', priority: 100 };
    expect(buildPlan([a, c]).map((s) => [s.start, s.end, s.primary.id])).toEqual([[0, 5, 'a'], [5, 15, 'c']]); // c takes over at 5
  });

  it('accepting turns primaries into schedule entries with channels', () => {
    const slots = buildPlan(planCandidates(input));
    const byId = Object.fromEntries(games.map((g) => [g.id, g]));
    const entries = planEntries(slots, byId, (c) => (c.eventId === 'nfl:1' ? 'ch-cbs' : undefined), 10);
    expect(entries.map((e) => e.id)).toEqual(['game:nfl:1', 'game:nfl:4']);
    expect(entries[0]).toMatchObject({ channelId: 'ch-cbs', reminderMin: 10, eventId: 'nfl:1' });
    expect(entries[0].notes).toContain('Smart Schedule: Your team');
  });
});

describe('auto-tune', () => {
  const entries = [{ id: 'game:nfl:1', start: T0, channelId: 'cbs' }, { id: 'game:nfl:4', start: T0 + 7 * HOUR, channelId: 'nbc' }];
  const ctx = { currentId: 'fox', fired: new Set<string>(), watchingMyTeam: false, dontInterrupt: true };
  it('tunes once, right when a planned item starts', () => {
    expect(autoTuneTarget(T0 - MIN, entries, ctx)).toBeUndefined();
    expect(autoTuneTarget(T0 + 30_000, entries, ctx)).toMatchObject({ channelId: 'cbs', key: `game:nfl:1:${T0}` });
    expect(autoTuneTarget(T0 + 30_000, entries, { ...ctx, fired: new Set([`game:nfl:1:${T0}`]) })).toBeUndefined();
    expect(autoTuneTarget(T0 + 10 * MIN, entries, ctx)).toBeUndefined(); // too late: don't yank the channel mid-game
    expect(autoTuneTarget(T0 + 30_000, entries, { ...ctx, currentId: 'cbs' })).toBeUndefined();
  });
  it("respects \"don't interrupt if I'm watching another of my teams\"", () => {
    expect(autoTuneTarget(T0 + 7 * HOUR, entries, { ...ctx, watchingMyTeam: true })).toBeUndefined();
    expect(autoTuneTarget(T0 + 7 * HOUR, entries, { ...ctx, watchingMyTeam: true, dontInterrupt: false })?.channelId).toBe('nbc');
  });
});

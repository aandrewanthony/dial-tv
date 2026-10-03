import { describe, expect, it } from 'vitest';
import { nyDate, parseScoreboard, shiftYmd } from '../../src/providers/espn';
import { gradePick, pickProfit, recordFor } from '../../src/lib/sports';
import { pickDates } from '../../src/hooks/useEngine';
import type { BetPick, SportEvent } from '../../src/types';

const game = (o: Partial<SportEvent>): SportEvent => ({
  id: 'nfl:1', league: 'nfl', start: 0, state: 'post', statusText: 'Final', period: 4,
  home: { id: 'h', abbr: 'CHI', name: 'Chicago', shortName: 'Bears' },
  away: { id: 'a', abbr: 'NYJ', name: 'New York', shortName: 'Jets' },
  homeScore: 21, awayScore: 21, broadcasts: [], completed: true, ...o,
});
const pick = (o: Partial<BetPick>): BetPick => ({ id: 'x', player: 'Me', eventId: 'nfl:1', league: 'nfl', market: 'moneyline', side: 'CHI', units: 1, createdAt: 0, label: '', ...o });

describe('grading edge cases', () => {
  it('voids postponed/canceled games instead of grading them as final', () => {
    expect(gradePick(pick({}), game({ postponed: true, completed: false, homeScore: 0, awayScore: 0 }))).toBe('void');
    expect(gradePick(pick({ market: 'spread', line: 3 }), game({ canceled: true }))).toBe('void');
    // Final state but not completed (e.g. suspended) → wait
    expect(gradePick(pick({}), game({ completed: false, homeScore: 24 }))).toBeUndefined();
  });

  it('void picks count separately and have no units', () => {
    const p = pick({ result: 'void', units: 3 });
    expect(pickProfit(p)).toBe(0);
    const r = recordFor('Me', [p, pick({ id: '2', createdAt: 1, result: 'win' })]);
    expect(r).toMatchObject({ voids: 1, wins: 1, pending: 0, streak: 'W1' });
  });

  it('soccer moneyline draw is a loss; other leagues push', () => {
    expect(gradePick(pick({ league: 'epl' }), game({ league: 'epl' }))).toBe('loss');
    expect(gradePick(pick({ league: 'mls' }), game({ league: 'mls' }))).toBe('loss');
    expect(gradePick(pick({}), game({}))).toBe('push');
  });

  it('spread/total picks without a line stay ungraded', () => {
    const g = game({ homeScore: 24 });
    expect(gradePick(pick({ market: 'spread' }), g)).toBeUndefined();
    expect(gradePick(pick({ market: 'total', side: 'over' }), g)).toBeUndefined();
    expect(gradePick(pick({ market: 'spread', line: 0 }), g)).toBe('win');
  });

  it('parses ESPN postponed status', () => {
    const json = {
      events: [{
        id: '9', date: '2026-10-03T17:00Z',
        status: { type: { state: 'post', completed: false, name: 'STATUS_POSTPONED', shortDetail: 'Postponed' } },
        competitions: [{ competitors: [{ homeAway: 'home', team: { id: '1', abbreviation: 'CHI' } }, { homeAway: 'away', team: { id: '2', abbreviation: 'NYJ' } }] }],
      }],
    };
    const [g] = parseScoreboard('nfl', json);
    expect(g).toMatchObject({ postponed: true, completed: false, statusName: 'STATUS_POSTPONED' });
    expect(gradePick(pick({ eventId: g.id }), g)).toBe('void');
  });
});

describe('ESPN dates', () => {
  it('computes the US-Eastern slate date regardless of local timezone', () => {
    // 2026-10-04 02:30 UTC = Oct 3 22:30 EDT
    expect(nyDate(Date.UTC(2026, 9, 4, 2, 30))).toBe('20261003');
    // 2026-01-15 04:59 UTC = Jan 14 23:59 EST
    expect(nyDate(Date.UTC(2026, 0, 15, 4, 59))).toBe('20260114');
    expect(nyDate(Date.UTC(2026, 0, 15, 5, 0))).toBe('20260115');
  });
  it('shifts dates across month/year boundaries and fetches adjacent days for picks', () => {
    expect(shiftYmd('20261231', 1)).toBe('20270101');
    expect(shiftYmd('20260301', -1)).toBe('20260228');
    expect(pickDates(Date.UTC(2026, 9, 4, 2, 30))).toEqual(['20261003', '20261002', '20261004']);
  });
});


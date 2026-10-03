import { describe, expect, it } from 'vitest';
import { nyDate, parseScoreboard, shiftYmd } from '../../src/providers/espn';
import { gradeLeg, type BetLeg } from '../../src/lib/sports';
import { pickDates } from '../../src/hooks/useEngine';
import type { SportEvent } from '../../src/types';

const game = (o: Partial<SportEvent>): SportEvent => ({
  id: 'nfl:1', league: 'nfl', start: 0, state: 'post', statusText: 'Final', period: 4,
  home: { id: 'h', abbr: 'CHI', name: 'Chicago', shortName: 'Bears' },
  away: { id: 'a', abbr: 'NYJ', name: 'New York', shortName: 'Jets' },
  homeScore: 21, awayScore: 21, broadcasts: [], completed: true, ...o,
});
const leg = (o: Partial<BetLeg>): Pick<BetLeg, 'market' | 'side' | 'line'> => ({ market: 'moneyline', side: 'CHI', ...o });

describe('grading edge cases', () => {
  it('voids postponed/canceled games instead of grading them as final', () => {
    expect(gradeLeg(leg({}), game({ postponed: true, completed: false, homeScore: 0, awayScore: 0 }))).toBe('void');
    expect(gradeLeg(leg({ market: 'spread', line: 3 }), game({ canceled: true }))).toBe('void');
    // Final state but not completed (e.g. suspended) → wait
    expect(gradeLeg(leg({}), game({ completed: false, homeScore: 24 }))).toBeUndefined();
  });

  it('soccer moneyline is 3-way: a draw loses team bets and wins the draw; other leagues push', () => {
    expect(gradeLeg(leg({}), game({ league: 'epl' }))).toBe('loss');
    expect(gradeLeg(leg({}), game({ league: 'mls' }))).toBe('loss');
    expect(gradeLeg(leg({ side: 'draw' }), game({ league: 'epl' }))).toBe('win');
    expect(gradeLeg(leg({ side: 'draw' }), game({ league: 'epl', homeScore: 2 }))).toBe('loss');
    expect(gradeLeg(leg({}), game({}))).toBe('push');
  });

  it('spread/total legs without a line, or with an unknown side, stay ungraded', () => {
    const g = game({ homeScore: 24 });
    expect(gradeLeg(leg({ market: 'spread' }), g)).toBeUndefined();
    expect(gradeLeg(leg({ market: 'total', side: 'over' }), g)).toBeUndefined();
    expect(gradeLeg(leg({ market: 'spread', line: 0 }), g)).toBe('win');
    expect(gradeLeg(leg({ side: 'GB' }), g)).toBeUndefined();
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
    expect(gradeLeg(leg({}), g)).toBe('void');
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
  it('shifts dates across month/year boundaries and fetches adjacent days for open bets', () => {
    expect(shiftYmd('20261231', 1)).toBe('20270101');
    expect(shiftYmd('20260301', -1)).toBe('20260228');
    expect(pickDates(Date.UTC(2026, 9, 4, 2, 30))).toEqual(['20261003', '20261002', '20261004']);
  });
});

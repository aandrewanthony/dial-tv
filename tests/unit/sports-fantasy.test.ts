import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { espnSeason, parseEspnLeague, PRO_TEAMS } from '../../src/providers/espnFantasy';
import { startSitHints, stakesByGame } from '../../src/store/fantasy';
import { parseTeamSchedule } from '../../src/providers/espn';
import type { SportEvent } from '../../src/types';

const ff = JSON.parse(readFileSync(resolve('tests/fixtures/espn-ff.json'), 'utf8'));

describe('ESPN Fantasy parsing', () => {
  const snap = parseEspnLeague(ff, '1');
  it('reads league, week, teams and owners', () => {
    expect(snap).toMatchObject({ week: 5, season: '2026', league: { id: '424242', name: 'Sunday Funday League' } });
    expect(snap.teams.map((t) => t.name)).toEqual(['Gridiron Gurus', 'Bro Ballers', 'Third Team', 'Fourth Team']);
    expect(snap.teams[0].owner).toBe('andrew_sf');
  });
  it('builds my matchup: starters in slot order, bench/IR separate, live points + projections', () => {
    const m = snap.matchup!;
    expect(m.week).toBe(5);
    expect(m.me.teamName).toBe('Gridiron Gurus');
    expect(m.opponent?.teamName).toBe('Bro Ballers');
    expect(m.me.starters).toEqual(['3918298', '4379399', '4241478', '4426515', '-16002']);
    expect(m.me.slots?.['4426515']).toBe('FLEX');
    expect(m.me.bench).toEqual(['4362628', '3054850']);
    expect(m.me.points).toBe(21.36);
    expect(m.me.playerPoints['3918298']).toBe(21.36);
    expect(m.me.playerProjections?.['3918298']).toBe(22.1);
    expect(m.opponent?.points).toBe(18);
  });
  it('maps proTeamId to ESPN NFL abbreviations and keeps injuries', () => {
    expect(snap.players['3918298']).toMatchObject({ name: 'Josh Allen', position: 'QB', team: 'BUF' });
    expect(snap.players['4426515'].team).toBe('WSH');
    expect(snap.players['4241478'].injury).toBe('QUESTIONABLE');
    expect(snap.players['-16002'].position).toBe('D/ST');
    expect(PRO_TEAMS[33]).toBe('BAL');
    expect(PRO_TEAMS[13]).toBe('LV');
  });
  it('no team chosen → no matchup; season boundary', () => {
    expect(parseEspnLeague(ff).matchup).toBeUndefined();
    expect(espnSeason(new Date(2027, 0, 20))).toBe('2026');
    expect(espnSeason(new Date(2026, 8, 1))).toBe('2026');
  });
  it('drives fantasy stakes and start/sit hints for ESPN players', () => {
    const game = (id: string, home: string, away: string): SportEvent => ({
      id, league: 'nfl', start: 0, state: 'pre', statusText: '', period: 0, broadcasts: [],
      home: { id: 'h', abbr: home, name: home, shortName: home }, away: { id: 'a', abbr: away, name: away, shortName: away },
    });
    const stakes = stakesByGame([game('nfl:1', 'WSH', 'IND'), game('nfl:2', 'BUF', 'NE')], snap.matchup, snap.players);
    expect(stakes.get('nfl:1')?.mine.map((p) => p.name).sort()).toEqual(['Michael Pittman Jr.', 'Terry McLaurin']);
    expect(stakes.get('nfl:1')?.theirs.map((p) => p.name)).toEqual(['Jonathan Taylor']);
    const hints = startSitHints(snap.matchup, snap.players, () => true);
    expect(hints).toEqual([{ benchId: '4362628', starterId: '4426515', gain: 8.4 }]);
    expect(startSitHints(snap.matchup, snap.players, () => false)).toEqual([]);
  });
});

describe('ESPN team schedule', () => {
  it('normalizes object scores and geo broadcasts and reads record/standing', () => {
    const json = {
      team: { id: '2', abbreviation: 'BUF', displayName: 'Buffalo Bills', shortDisplayName: 'Bills', recordSummary: '3-0', standingSummary: '1st in AFC East', logos: [{ href: 'https://a.espncdn.com/buf.png' }] },
      byeWeek: 7,
      events: [
        { id: '10', date: '2026-10-13T00:15Z', competitions: [{ status: { type: { state: 'pre', name: 'STATUS_SCHEDULED' } }, broadcasts: [{ type: { shortName: 'TV' }, media: { shortName: 'ESPN' } }],
          competitors: [{ homeAway: 'home', team: { id: '14', abbreviation: 'LAR', displayName: 'Los Angeles Rams' } }, { homeAway: 'away', team: { id: '2', abbreviation: 'BUF', displayName: 'Buffalo Bills' } }] }] },
        { id: '9', date: '2026-09-27T17:00Z', competitions: [{ status: { type: { state: 'post', completed: true, name: 'STATUS_FINAL', shortDetail: 'Final' } }, broadcasts: [],
          competitors: [{ homeAway: 'home', score: { value: 41, displayValue: '41' }, team: { id: '2', abbreviation: 'BUF' } }, { homeAway: 'away', score: { value: 10, displayValue: '10' }, team: { id: '17', abbreviation: 'NE' } }] }] },
      ],
    };
    const s = parseTeamSchedule('nfl', json);
    expect(s.team).toMatchObject({ abbr: 'BUF', record: '3-0', standing: '1st in AFC East' });
    expect(s.byeWeek).toBe(7);
    expect(s.events.map((e) => e.id)).toEqual(['nfl:9', 'nfl:10']);
    expect(s.events[0]).toMatchObject({ state: 'post', homeScore: 41, awayScore: 10 });
    expect(s.events[1].broadcasts).toEqual(['ESPN']);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseScoreboard } from '../../src/providers/espn';
import { clutchInfo, gradeLeg, payout, spreadFor, type BetLeg } from '../../src/lib/sports';
import { canonicalNetwork, matchBroadcasts, matchNetwork } from '../../src/lib/channelMatch';
import { stakesByGame } from '../../src/store/fantasy';
import type { Channel, SportEvent } from '../../src/types';

const espn = JSON.parse(readFileSync(resolve('tests/fixtures/espn-nfl.json'), 'utf8'));

const base = (o: Partial<SportEvent>): SportEvent => ({
  id: 'nfl:1', league: 'nfl', start: 0, state: 'in', statusText: '', period: 4, clock: 120,
  home: { id: 'h', abbr: 'CHI', name: 'Chicago Bears', shortName: 'Bears' },
  away: { id: 'a', abbr: 'NYJ', name: 'New York Jets', shortName: 'Jets' },
  homeScore: 21, awayScore: 17, broadcasts: ['FOX'], ...o,
});

describe('ESPN adapter', () => {
  it('parses a real scoreboard payload', () => {
    const games = parseScoreboard('nfl', espn);
    expect(games).toHaveLength(2);
    const g = games[0];
    expect(g.id).toMatch(/^nfl:\d+$/);
    expect(g.home.abbr).toMatch(/^[A-Z]{2,4}$/);
    expect(g.home.logo).toMatch(/^https:\/\//);
    expect(g.broadcasts.length).toBeGreaterThan(0);
    expect(g.broadcasts).not.toContain('ERADM'); // radio filtered
    if (g.state === 'post') expect(typeof g.homeScore).toBe('number');
    if (g.state === 'pre') expect(g.homeScore).toBeUndefined();
  });

  it('tolerates junk', () => {
    expect(parseScoreboard('nba', null)).toEqual([]);
    expect(parseScoreboard('nba', { events: [{ competitions: [{}] }] })).toEqual([]);
  });
});

describe('clutch detection', () => {
  it('flags one-score 4th quarter NFL games under 5:00', () => {
    expect(clutchInfo(base({})).clutch).toBe(true);
    expect(clutchInfo(base({ clock: 600 })).clutch).toBe(false);
    expect(clutchInfo(base({ homeScore: 35 })).clutch).toBe(false);
    expect(clutchInfo(base({ period: 5 })).reason).toBe('Overtime');
    expect(clutchInfo(base({ state: 'pre' })).score).toBe(0);
  });
  it('MLB late & close, NHL tied in 3rd', () => {
    expect(clutchInfo(base({ league: 'mlb', period: 9, homeScore: 3, awayScore: 2 })).clutch).toBe(true);
    expect(clutchInfo(base({ league: 'mlb', period: 5, homeScore: 3, awayScore: 2 })).clutch).toBe(false);
    expect(clutchInfo(base({ league: 'nhl', period: 3, clock: 300, homeScore: 2, awayScore: 2 })).clutch).toBe(true);
  });
  it('closer + later scores higher', () => {
    expect(clutchInfo(base({ clock: 30, homeScore: 20, awayScore: 20 })).score).toBeGreaterThan(clutchInfo(base({ period: 2, clock: 600 })).score);
  });
});

describe('bet legs', () => {
  const leg = (o: Partial<BetLeg>): Pick<BetLeg, 'market' | 'side' | 'line'> => ({ market: 'spread', side: 'NYJ', ...o });
  const final = base({ state: 'post', homeScore: 24, awayScore: 21 });

  it('grades spreads incl. pushes', () => {
    expect(gradeLeg(leg({ line: 3.5 }), final)).toBe('win'); // NYJ +3.5 lose by 3
    expect(gradeLeg(leg({ line: 3 }), final)).toBe('push');
    expect(gradeLeg(leg({ line: 2.5 }), final)).toBe('loss');
    expect(gradeLeg(leg({ side: 'CHI', line: -2.5 }), final)).toBe('win');
  });
  it('grades moneyline and totals; ignores non-final games', () => {
    expect(gradeLeg(leg({ market: 'moneyline', side: 'CHI' }), final)).toBe('win');
    expect(gradeLeg(leg({ market: 'total', side: 'over', line: 44.5 }), final)).toBe('win');
    expect(gradeLeg(leg({ market: 'total', side: 'under', line: 44.5 }), final)).toBe('loss');
    expect(gradeLeg(leg({ line: 3 }), base({}))).toBeUndefined();
  });
  it('computes payouts', () => {
    expect(payout(1, '-110')).toBeCloseTo(0.909, 3);
    expect(payout(2, '+150')).toBe(3);
  });
  it('derives spread from either side', () => {
    const g = base({ odds: { provider: 'X', spread: 4.5, favoriteAbbr: 'NYJ' } });
    expect(spreadFor(g, 'NYJ')).toBe(-4.5);
    expect(spreadFor(g, 'CHI')).toBe(4.5);
  });
});

describe('Smart Sports Mapper', () => {
  const ch = (id: string, name: string): Channel => ({ id, name, number: 1, group: '', mark: '', url: 'https://x', sourceId: 's' });
  const channels = [ch('e', 'US| ESPN HD'), ch('e2', 'ESPN 2'), ch('f', 'FOX (WNYW) New York'), ch('fn', 'FOX News'), ch('n', 'NFL Network'), ch('c', 'CBS 2 Chicago')];

  it('canonicalizes broadcaster aliases', () => {
    expect(canonicalNetwork('NFL Net')).toBe('nfl network');
    expect(canonicalNetwork('ESPN2')).toBe('espn2');
    expect(canonicalNetwork('FS1')).toBe('fs1');
  });
  it('matches exact, alias, and affiliate names without confusing variants', () => {
    expect(matchNetwork('ESPN', channels)).toMatchObject({ channel: { id: 'e' }, reason: 'exact' });
    expect(matchNetwork('ESPN2', channels)!.channel.id).toBe('e2');
    expect(matchNetwork('FOX', channels)!.channel.id).toBe('f');
    expect(matchNetwork('NFL Net', channels)!.channel.id).toBe('n');
    expect(matchNetwork('CBS', channels)!.channel.id).toBe('c');
    expect(matchNetwork('TNT', channels)).toBeNull();
    // ESPN must never fall back to ESPN 2, nor FOX to FOX News.
    expect(matchNetwork('ESPN', channels.filter((c) => c.id !== 'e'))).toBeNull();
    expect(matchNetwork('FOX', channels.filter((c) => c.id !== 'f'))).toBeNull();
  });
  it('honours manual overrides and picks the best broadcaster', () => {
    expect(matchNetwork('TNT', channels, { tnt: 'n' })).toMatchObject({ channel: { id: 'n' }, confidence: 1, reason: 'manual' });
    expect(matchBroadcasts(['Peacock', 'NBC', 'CBS'], channels)!.network).toBe('CBS');
  });
});

describe('fantasy stakes', () => {
  it('counts my and opponent starters per NFL game', () => {
    const g = base({});
    const players = { p1: { id: 'p1', name: 'A', position: 'WR', team: 'NYJ' }, p2: { id: 'p2', name: 'B', position: 'RB', team: 'CHI' }, p3: { id: 'p3', name: 'C', position: 'QB', team: 'BUF' } };
    const matchup = {
      week: 5,
      me: { rosterId: 1, ownerName: 'me', teamName: 'Mine', starters: ['p1', 'p3'], points: 0, playerPoints: {} },
      opponent: { rosterId: 2, ownerName: 'o', teamName: 'Theirs', starters: ['p2'], points: 0, playerPoints: {} },
    };
    const st = stakesByGame([g], matchup, players).get(g.id)!;
    expect(st.mine.map((p) => p.id)).toEqual(['p1']);
    expect(st.theirs.map((p) => p.id)).toEqual(['p2']);
    expect(st.score).toBe(2.25);
    expect(stakesByGame([g], undefined, players).size).toBe(0);
  });
});

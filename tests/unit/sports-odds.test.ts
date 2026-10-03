import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  americanToDecimal, bestIndex, betProfit, betsToCsv, decimalToAmerican, gradeBets, impliedProb, noVig, parlayPrice, probToAmerican,
  settleBet, summarize, vig, weekLoss, weeklyProfit, type Bet, type BetLeg,
} from '../../src/lib/sports';
import {
  cleanLink, espnOddsEvent, leaguesDue, matchGame, parseOddsResponse, pushSnapshot, snapshotOf, summarizeSide,
} from '../../src/providers/oddsapi';
import { parseScoreboard } from '../../src/providers/espn';
import { migrate, SCHEMA_VERSION } from '../../src/store/app';
import type { SportEvent } from '../../src/types';

const oddsFixture = JSON.parse(readFileSync(resolve('tests/fixtures/oddsapi-nfl.json'), 'utf8'));
const espnFixture = JSON.parse(readFileSync(resolve('tests/fixtures/espn-nfl.json'), 'utf8'));

describe('odds math', () => {
  it('converts American ↔ decimal and implied probability', () => {
    expect(americanToDecimal(-110)).toBeCloseTo(1.9091, 4);
    expect(americanToDecimal(150)).toBe(2.5);
    expect(decimalToAmerican(2.5)).toBe(150);
    expect(decimalToAmerican(1.5)).toBe(-200);
    expect(impliedProb(-110)).toBeCloseTo(0.5238, 4);
    expect(impliedProb(200)).toBeCloseTo(1 / 3, 6);
  });
  it('removes the vig', () => {
    const [a, b] = noVig([-110, -110]);
    expect(a).toBeCloseTo(0.5, 6);
    expect(b).toBeCloseTo(0.5, 6);
    expect(vig([-110, -110])).toBeCloseTo(0.0476, 4);
    const [fav, dog] = noVig([-205, 170]);
    expect(fav + dog).toBeCloseTo(1, 9);
    expect(fav).toBeGreaterThan(0.6);
    expect(probToAmerican(0.5)).toBe(100);
    expect(probToAmerican(2 / 3)).toBe(-200);
  });
  it('finds the best line: more points first, then price', () => {
    expect(bestIndex('ml', [{ price: -120 }, { price: -105 }, undefined, { price: -110 }])).toBe(1);
    expect(bestIndex('spread', [{ price: -110, point: 3 }, { price: -125, point: 3.5 }, { price: +100, point: 3 }])).toBe(1);
    expect(bestIndex('over', [{ price: -110, point: 47.5 }, { price: -120, point: 46.5 }])).toBe(1);
    expect(bestIndex('under', [{ price: -110, point: 47.5 }, { price: -105, point: 46.5 }])).toBe(0);
    expect(bestIndex('ml', [])).toBe(-1);
  });
  it('prices parlays', () => {
    const p = parlayPrice([-110, -110], 10);
    expect(p.decimal).toBeCloseTo(3.6446, 4);
    expect(p.american).toBe(264);
    expect(p.payout).toBeCloseTo(36.45, 2);
    expect(p.prob).toBeCloseTo(0.2744, 4);
  });
});

const g = (id: string, o: Partial<SportEvent>): SportEvent => ({
  id, league: 'nfl', start: 0, state: 'post', statusText: 'Final', period: 4, completed: true,
  home: { id: 'h', abbr: 'CHI', name: 'Chicago Bears', shortName: 'Bears' },
  away: { id: 'a', abbr: 'NYJ', name: 'New York Jets', shortName: 'Jets' },
  homeScore: 24, awayScore: 21, broadcasts: [], ...o,
});
const leg = (o: Partial<BetLeg>): BetLeg => ({ id: Math.random().toString(36), league: 'nfl', game: 'NYJ @ CHI', market: 'moneyline', side: 'CHI', odds: -110, eventId: 'nfl:1', ...o });
const bet = (o: Partial<Bet>): Bet => ({ id: 'b', book: 'fanduel', type: 'straight', legs: [leg({})], odds: -110, stake: 110, placedAt: 0, status: 'open', ...o });

describe('bet grading', () => {
  it('grades straight bets from final scores, incl. push and void', () => {
    const games = { 'nfl:1': g('nfl:1', {}) };
    const [won] = gradeBets([bet({})], games, 1000);
    expect(won).toMatchObject({ status: 'won', returned: 210, settledAt: 1000 });
    expect(betProfit(won)).toBe(100);
    const [push] = gradeBets([bet({ legs: [leg({ market: 'spread', side: 'NYJ', line: 3 })] })], games);
    expect(push).toMatchObject({ status: 'push', returned: 110 });
    expect(betProfit(push)).toBe(0);
    const [v] = gradeBets([bet({})], { 'nfl:1': g('nfl:1', { postponed: true, completed: false }) });
    expect(v.status).toBe('void');
    const pending = [bet({})];
    expect(gradeBets(pending, { 'nfl:1': g('nfl:1', { state: 'in' }) })).toBe(pending); // unchanged reference
  });

  it('parlays: any loss loses; pushes/voids drop the leg and reprice', () => {
    const games = {
      'nfl:1': g('nfl:1', {}), // CHI 24-21
      'nfl:2': g('nfl:2', { homeScore: 20, awayScore: 17 }), // push on -3
      'nfl:3': g('nfl:3', { postponed: true, completed: false }),
      'nfl:4': g('nfl:4', { homeScore: 10, awayScore: 30 }),
    };
    const parlay = (legs: BetLeg[], odds = 600) => bet({ type: 'parlay', legs, odds, stake: 10 });
    const [lost] = gradeBets([parlay([leg({}), leg({ eventId: 'nfl:4' }), leg({ eventId: 'nfl:9' })])], games);
    expect(lost.status).toBe('lost'); // settles even with a leg still pending
    expect(betProfit(lost)).toBe(-10);
    const [repriced] = gradeBets([parlay([leg({ odds: 150 }), leg({ eventId: 'nfl:2', market: 'spread', line: -3 }), leg({ eventId: 'nfl:3' })])], games);
    expect(repriced.status).toBe('won');
    expect(repriced.returned).toBe(25); // only the +150 leg remains: 10 × 2.5
    const [allPush] = gradeBets([parlay([leg({ eventId: 'nfl:2', market: 'spread', line: -3 }), leg({ eventId: 'nfl:3' })])], games);
    expect(allPush).toMatchObject({ status: 'push', returned: 10 });
    const [allWon] = gradeBets([parlay([leg({}), leg({ eventId: 'nfl:2', market: 'total', side: 'over', line: 36.5 })], 280)], games);
    expect(allWon).toMatchObject({ status: 'won', returned: 38 }); // the ticket's own price
  });

  it('never auto-grades manual settlements; summarizes P/L, ROI, weeks and CSV', () => {
    const manual = bet({ id: 'm', status: 'cashout', returned: 60, stake: 100, manual: true, settledAt: Date.now() });
    expect(settleBet(manual)).toBe(manual);
    expect(betProfit(manual)).toBe(-40);
    const bets = [manual, bet({ id: 'w', status: 'won', returned: 210, settledAt: Date.now() }), bet({ id: 'o' }), bet({ id: 'p', status: 'push', returned: 110, settledAt: Date.now() })];
    const s = summarize(bets);
    expect(s).toMatchObject({ bets: 4, open: 1, won: 1, lost: 1, pushed: 1, risked: 210, profit: 60 });
    expect(s.roi).toBeCloseTo(60 / 210, 6);
    expect(weekLoss(bets)).toBe(0);
    expect(weekLoss([manual])).toBe(40);
    const weeks = weeklyProfit(bets);
    expect(weeks).toHaveLength(12);
    expect(weeks[11].profit).toBe(60);
    const csv = betsToCsv([bet({ notes: '=HYPERLINK("x")' })]);
    expect(csv.split('\n')[0]).toContain('placed,book,type');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('The Odds API', () => {
  const events = parseOddsResponse('nfl', oddsFixture);
  it('parses the recorded response: books, markets, links', () => {
    expect(events).toHaveLength(oddsFixture.length);
    const ev = events[0];
    expect(ev).toMatchObject({ home: 'Washington Commanders', away: 'Indianapolis Colts', source: 'oddsapi' });
    expect(ev.books.length).toBeGreaterThan(3);
    const dk = ev.books.find((b) => b.book === 'draftkings')!;
    expect(dk.ml?.away?.price).toBe(-205);
    expect(dk.spread?.away).toMatchObject({ point: -4.5, price: -105 });
    expect(dk.total?.over?.point).toBe(46.5);
    expect(dk.link).toMatch(/^https:\/\/sportsbook\.draftkings\.com\//);
    expect(dk.ml?.away?.link).toMatch(/^https:\/\//);
    expect(events.every((e) => e.books.every((b) => b.link == null || b.link.startsWith('https://')))).toBe(true);
  });
  it('matches books events to ESPN games and summarizes a market', () => {
    const games = parseScoreboard('nfl', espnFixture);
    const ev = events[0];
    expect(matchGame(ev, games)?.away.abbr).toBe('IND');
    const sum = summarizeSide(ev.books, 'spread', 'away');
    expect(sum.best).toBeGreaterThanOrEqual(0);
    expect(sum.consensusPoint).toBeLessThan(0);
    expect(sum.fair).toBeGreaterThan(0.3);
    const ml = summarizeSide(ev.books, 'ml', 'away');
    const prices = ev.books.map((b) => b.ml?.away?.price ?? -Infinity);
    expect(ev.books[ml.best].ml!.away!.price).toBe(Math.max(...prices));
  });
  it('falls back to ESPN odds and records line movement only on change', () => {
    const games = parseScoreboard('nfl', espnFixture);
    const withOdds = games.find((x) => x.odds)!;
    const ev = espnOddsEvent(withOdds)!;
    expect(ev.source).toBe('espn');
    expect(ev.books).toHaveLength(1);
    const s1 = snapshotOf(ev, 1);
    const h1 = pushSnapshot(undefined, s1);
    expect(pushSnapshot(h1, { ...s1, at: 2 })).toBe(h1);
    expect(pushSnapshot(h1, { ...s1, at: 3, spread: (s1.spread ?? 0) + 1 })).toHaveLength(2);
  });
  it('strips tracking params, rejects non-https links', () => {
    expect(cleanLink('https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2&utm_source=x&btag=y')).toBe('https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2');
    expect(cleanLink('javascript:alert(1)')).toBeUndefined();
    expect(cleanLink('http://insecure.example')).toBeUndefined();
  });
  it('refreshes only leagues with games soon and a stale cache', () => {
    const now = Date.UTC(2026, 9, 4, 12);
    const games = [g('nfl:1', { state: 'pre', start: now + 3 * 3600e3 }), g('nba:1', { league: 'nba', state: 'pre', start: now + 3 * 86400e3 })];
    expect(leaguesDue(now, ['nfl', 'nba', 'ncaam'], games, {}, 15)).toEqual(['nfl']);
    expect(leaguesDue(now, ['nfl'], games, { nfl: now - 5 * 60e3 }, 15)).toEqual([]);
    expect(leaguesDue(now, ['nfl'], games, {}, 0)).toEqual([]);
  });
});

describe('app store v5 migration', () => {
  it("drops pick'em state and marks existing fans as onboarded", () => {
    const m = migrate({ version: 4, favTeams: ['nfl:BUF'], picks: [{ id: 'x' }], pickPlayers: ['Me', 'Bro'] }) as unknown as Record<string, unknown>;
    expect(m.version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    expect('picks' in m).toBe(false);
    expect('pickPlayers' in m).toBe(false);
    expect(m.sportsOnboarded).toBe(true);
    expect((migrate({ version: 4 }) as unknown as Record<string, unknown>).sportsOnboarded).toBe(false);
  });
});

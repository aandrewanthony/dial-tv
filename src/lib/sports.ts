import type { League, SportEvent } from '../types';

export const LEAGUES: { id: League; label: string; sport: string }[] = [
  { id: 'nfl', label: 'NFL', sport: 'football' },
  { id: 'ncaaf', label: 'NCAAF', sport: 'football' },
  { id: 'nba', label: 'NBA', sport: 'basketball' },
  { id: 'wnba', label: 'WNBA', sport: 'basketball' },
  { id: 'ncaam', label: 'NCAAM', sport: 'basketball' },
  { id: 'mlb', label: 'MLB', sport: 'baseball' },
  { id: 'nhl', label: 'NHL', sport: 'hockey' },
  { id: 'mls', label: 'MLS', sport: 'soccer' },
  { id: 'epl', label: 'EPL', sport: 'soccer' },
];

export const leagueLabel = (l: League) => LEAGUES.find((x) => x.id === l)?.label ?? l.toUpperCase();

export interface ClutchInfo {
  clutch: boolean;
  /** 0–100, higher = more worth watching right now. */
  score: number;
  reason?: string;
}

/**
 * "Clutch" detection: a live game that is close late. Thresholds are per sport
 * and deliberately conservative so alerts stay meaningful.
 */
export function clutchInfo(g: SportEvent): ClutchInfo {
  if (g.state !== 'in' || g.homeScore == null || g.awayScore == null) return { clutch: false, score: 0 };
  const diff = Math.abs(g.homeScore - g.awayScore);
  const clock = g.clock ?? Infinity;
  const p = g.period;
  let clutch = false;
  let late = 0; // 0..1 how late in the game
  let close = 0; // 0..1 how close
  let reason: string | undefined;

  switch (g.league) {
    case 'nfl':
    case 'ncaaf':
      late = p >= 5 ? 1 : p === 4 ? 1 - Math.min(clock, 900) / 900 : (p - 1) / 4;
      close = Math.max(0, 1 - diff / 17);
      clutch = (p === 4 && clock <= 300 && diff <= 8) || (p >= 5);
      reason = p >= 5 ? 'Overtime' : `One-score game, ${Math.ceil(clock / 60)} min left`;
      break;
    case 'nba':
    case 'wnba': {
      const qLen = g.league === 'nba' ? 720 : 600;
      late = p >= 5 ? 1 : p === 4 ? 1 - Math.min(clock, qLen) / qLen : (p - 1) / 4;
      close = Math.max(0, 1 - diff / 15);
      clutch = (p === 4 && clock <= 300 && diff <= 6) || p >= 5;
      reason = p >= 5 ? 'Overtime' : `${diff}-pt game under 5:00`;
      break;
    }
    case 'ncaam':
      late = p >= 3 ? 1 : p === 2 ? 1 - Math.min(clock, 1200) / 1200 : 0.25;
      close = Math.max(0, 1 - diff / 15);
      clutch = (p === 2 && clock <= 300 && diff <= 6) || p >= 3;
      reason = p >= 3 ? 'Overtime' : `${diff}-pt game under 5:00`;
      break;
    case 'nhl':
      late = p >= 4 ? 1 : p === 3 ? 1 - Math.min(clock, 1200) / 1200 : (p - 1) / 3;
      close = diff === 0 ? 1 : diff === 1 ? 0.75 : diff === 2 ? 0.3 : 0;
      clutch = (p === 3 && clock <= 600 && diff <= 1) || p >= 4;
      reason = p >= 4 ? 'Overtime' : diff === 0 ? 'Tied in the 3rd' : 'One-goal game in the 3rd';
      break;
    case 'mlb':
      late = Math.min(p, 9) / 9;
      close = diff === 0 ? 1 : diff === 1 ? 0.8 : diff === 2 ? 0.5 : Math.max(0, 1 - diff / 6);
      clutch = (p >= 8 && diff <= 2) || p >= 10;
      reason = p >= 10 ? 'Extra innings' : `${diff === 0 ? 'Tied' : diff + '-run game'} in the ${p}th`;
      break;
    case 'mls':
    case 'epl': {
      // Soccer clock counts up in seconds.
      const elapsed = g.clock ?? 0;
      late = Math.min(elapsed, 5400) / 5400;
      close = diff === 0 ? 1 : diff === 1 ? 0.7 : 0.1;
      clutch = elapsed >= 75 * 60 && diff <= 1;
      reason = diff === 0 ? 'Level late' : 'One-goal game late';
      break;
    }
  }
  const score = Math.round(100 * (0.45 * close + 0.35 * late + (clutch ? 0.2 : 0)));
  return { clutch, score, reason: clutch ? reason : undefined };
}

// ---------- Odds math ----------

/** Profit for a winning stake at an American price (default -110). */
export function payout(units: number, price = '-110') {
  const n = parseInt(price, 10);
  if (!Number.isFinite(n) || n === 0) return units * (100 / 110);
  return n > 0 ? units * (n / 100) : units * (100 / Math.abs(n));
}

/** Decimal odds for an American price (e.g. -110 → 1.909, +150 → 2.5). */
export function americanToDecimal(a: number): number {
  if (!Number.isFinite(a) || a === 0) return 1;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

/** American price for decimal odds (rounded to a whole number). */
export function decimalToAmerican(d: number): number {
  if (!Number.isFinite(d) || d <= 1) return 0;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/** Implied win probability (0–1) of an American price, vig included. */
export const impliedProb = (a: number) => 1 / americanToDecimal(a);

/** Remove the bookmaker margin: normalize the implied probabilities of every outcome of one market to sum to 1. */
export function noVig(prices: number[]): number[] {
  const p = prices.map(impliedProb);
  const sum = p.reduce((a, b) => a + b, 0);
  return sum > 0 ? p.map((x) => x / sum) : p;
}

/** Bookmaker margin (overround) of one market, e.g. 0.0476 for -110/-110. */
export function vig(prices: number[]): number {
  return prices.reduce((a, b) => a + impliedProb(b), 0) - 1;
}

/** Fair American price for a probability. */
export const probToAmerican = (p: number) => (p > 0 && p < 1 ? decimalToAmerican(1 / p) : 0);

export function fmtAmerican(a: number | undefined): string {
  if (a == null || !Number.isFinite(a) || a === 0) return '—';
  return a > 0 ? `+${a}` : `${a}`;
}

export const fmtPct = (p: number | undefined, digits = 1) => (p == null || !Number.isFinite(p) ? '—' : `${(p * 100).toFixed(digits)}%`);

export const fmtMoney = (n: number, sign = false) => {
  const s = Math.abs(n).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-${s}` : sign && n > 0 ? `+${s}` : s;
};

export function median(xs: number[]): number | undefined {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return undefined;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type LineKind = 'ml' | 'spread' | 'over' | 'under';

/**
 * How good a line is for the bettor, to compare books on the same side of a market:
 * more points first (spread +7 beats +6.5; over: a lower total; under: a higher total), then the better price.
 */
export function lineValue(kind: LineKind, price: number, point?: number): number {
  const pts = point == null ? 0 : kind === 'over' ? -point : point;
  // Half a point outweighs any price difference within the same number.
  return (kind === 'ml' ? 0 : pts * 1000) + americanToDecimal(price);
}

/** Index of the best line among offers (ties: first). -1 when there are none. */
export function bestIndex(kind: LineKind, offers: ({ price: number; point?: number } | undefined)[]): number {
  let best = -1;
  let bv = -Infinity;
  offers.forEach((o, i) => {
    if (!o || !Number.isFinite(o.price) || o.price === 0) return;
    const v = lineValue(kind, o.price, o.point);
    if (v > bv) {
      bv = v;
      best = i;
    }
  });
  return best;
}

/** Parlay: combined decimal/American odds, payout for a stake, and the implied probability (independent legs). */
export function parlayPrice(legOdds: number[], stake = 0) {
  const dec = legOdds.reduce((a, o) => a * americanToDecimal(o), 1);
  return {
    decimal: dec,
    american: legOdds.length ? decimalToAmerican(dec) : 0,
    payout: stake * dec,
    profit: stake * (dec - 1),
    prob: legOdds.length ? legOdds.reduce((a, o) => a * impliedProb(o), 1) : 0,
  };
}

// ---------- Bet tracking & grading ----------

export type BetMarket = 'moneyline' | 'spread' | 'total';
export type LegResult = 'win' | 'loss' | 'push' | 'void';
export type BetStatus = 'open' | 'won' | 'lost' | 'push' | 'void' | 'cashout';

export interface BetLeg {
  id: string;
  /** ESPN game id (`league:id`) when the leg is tied to a game: enables auto-grading. */
  eventId?: string;
  league: League;
  /** Game start, so the game can be re-fetched for grading after it leaves the live window. */
  start?: number;
  /** Display label, e.g. "BUF @ KC". */
  game: string;
  market: BetMarket;
  /** Team abbreviation (moneyline/spread), 'draw' (soccer 3-way), or 'over' / 'under'. */
  side: string;
  /** Spread from the picked side's perspective, or the total. */
  line?: number;
  /** American price. */
  odds: number;
  result?: LegResult;
}

export interface Bet {
  id: string;
  /** Sportsbook key, e.g. 'fanduel'. */
  book: string;
  type: 'straight' | 'parlay';
  legs: BetLeg[];
  /** American price at placement (parlay: the combined price on the ticket). */
  odds: number;
  stake: number;
  placedAt: number;
  notes?: string;
  status: BetStatus;
  /** Money back when settled (stake + profit; push/void = stake; cash-out = amount received). */
  returned?: number;
  settledAt?: number;
  /** Settled by hand (cash-out or override): never auto-graded again. */
  manual?: boolean;
}

const SOCCER = new Set<League>(['mls', 'epl']);
export const isSoccer = (l: League) => SOCCER.has(l);

/**
 * Grade one leg against a game. undefined while the game isn't final (or the leg can't be graded,
 * e.g. a spread with no line or a side that isn't one of the teams). Postponed/canceled → 'void'.
 * Soccer moneylines are 3-way: a draw loses either team (and wins 'draw').
 */
export function gradeLeg(leg: Pick<BetLeg, 'market' | 'side' | 'line'>, g: SportEvent | undefined): LegResult | undefined {
  if (!g) return undefined;
  if (g.postponed || g.canceled) return 'void';
  if (g.state !== 'post' || g.completed === false || g.homeScore == null || g.awayScore == null) return undefined;
  if ((leg.market === 'spread' || leg.market === 'total') && leg.line == null) return undefined;
  if (leg.market === 'total') {
    if (leg.side !== 'over' && leg.side !== 'under') return undefined;
    const total = g.homeScore + g.awayScore;
    const m = leg.side === 'over' ? total - leg.line! : leg.line! - total;
    return m > 0 ? 'win' : m < 0 ? 'loss' : 'push';
  }
  if (leg.side === 'draw') {
    if (leg.market !== 'moneyline') return undefined;
    return g.homeScore === g.awayScore ? 'win' : 'loss';
  }
  if (leg.side !== g.home.abbr && leg.side !== g.away.abbr) return undefined;
  const pickedHome = leg.side === g.home.abbr;
  const mine = pickedHome ? g.homeScore : g.awayScore;
  const theirs = pickedHome ? g.awayScore : g.homeScore;
  let margin = mine - theirs;
  if (leg.market === 'moneyline') {
    if (margin === 0 && SOCCER.has(g.league)) return 'loss';
  } else margin += leg.line!;
  return margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push';
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Settle a bet from its legs' results. Parlays: any losing leg loses the ticket; pushed/void legs drop out
 * and the ticket is repriced on the remaining winners; if every leg pushed/voided the stake comes back.
 */
export function settleBet(b: Bet, now = Date.now()): Bet {
  if (b.manual) return b;
  const results = b.legs.map((l) => l.result);
  let status: BetStatus = 'open';
  let returned: number | undefined;
  if (b.legs.length === 1) {
    const r = results[0];
    if (r === 'win') { status = 'won'; returned = b.stake * americanToDecimal(b.odds); }
    else if (r === 'loss') { status = 'lost'; returned = 0; }
    else if (r === 'push') { status = 'push'; returned = b.stake; }
    else if (r === 'void') { status = 'void'; returned = b.stake; }
  } else if (results.includes('loss')) {
    status = 'lost';
    returned = 0;
  } else if (results.every((r) => r != null)) {
    const winners = b.legs.filter((l) => l.result === 'win');
    if (!winners.length) {
      status = results.every((r) => r === 'void') ? 'void' : 'push';
      returned = b.stake;
    } else {
      status = 'won';
      // Every leg won: pay the price on the ticket (books round/boost). Otherwise reprice on the winners.
      returned = winners.length === b.legs.length ? b.stake * americanToDecimal(b.odds) : parlayPrice(winners.map((l) => l.odds), b.stake).payout;
    }
  }
  const ret = returned == null ? undefined : cents(returned);
  if (status === b.status && ret === b.returned) return b;
  return { ...b, status, returned: ret, settledAt: status === 'open' ? undefined : b.settledAt ?? now };
}

/** Grade every open, auto-graded bet against the games. Returns the same array when nothing changed. */
export function gradeBets(bets: Bet[], games: Record<string, SportEvent>, now = Date.now()): Bet[] {
  let changed = false;
  const out = bets.map((b) => {
    if (b.manual || b.status !== 'open') return b;
    let legsChanged = false;
    const legs = b.legs.map((l) => {
      if (l.result || !l.eventId) return l;
      const r = gradeLeg(l, games[l.eventId]);
      if (!r) return l;
      legsChanged = true;
      return { ...l, result: r };
    });
    const next = settleBet(legsChanged ? { ...b, legs } : b, now);
    if (next !== b) changed = true;
    return next;
  });
  return changed ? out : bets;
}

/** Profit (+) or loss (−) of a bet; 0 while open. */
export function betProfit(b: Bet): number {
  if (b.status === 'open') return 0;
  if (b.status === 'lost') return -b.stake;
  return cents((b.returned ?? b.stake) - b.stake);
}

/** What an open bet pays back if it wins. */
export const potentialReturn = (b: Pick<Bet, 'stake' | 'odds'>) => cents(b.stake * americanToDecimal(b.odds));

export interface BetSummary {
  bets: number;
  open: number;
  openStake: number;
  won: number;
  lost: number;
  pushed: number;
  /** Stake of settled bets (push/void excluded). */
  risked: number;
  profit: number;
  /** profit / risked */
  roi: number;
}

export function summarize(bets: Bet[]): BetSummary {
  const s: BetSummary = { bets: bets.length, open: 0, openStake: 0, won: 0, lost: 0, pushed: 0, risked: 0, profit: 0, roi: 0 };
  for (const b of bets) {
    if (b.status === 'open') {
      s.open++;
      s.openStake += b.stake;
      continue;
    }
    if (b.status === 'push' || b.status === 'void') {
      s.pushed++;
      continue;
    }
    const p = betProfit(b);
    if (p > 0) s.won++;
    else if (p < 0) s.lost++;
    s.risked += b.stake;
    s.profit = cents(s.profit + p);
  }
  s.roi = s.risked ? s.profit / s.risked : 0;
  return s;
}

/** Sport bucket of a bet: its league, or 'Multi' for cross-league parlays. */
export function betSport(b: Bet): string {
  const ls = new Set(b.legs.map((l) => l.league));
  return ls.size === 1 ? leagueLabel([...ls][0]) : 'Multi';
}

export function groupSummary(bets: Bet[], key: (b: Bet) => string): [string, BetSummary][] {
  const m = new Map<string, Bet[]>();
  for (const b of bets) {
    const k = key(b);
    const arr = m.get(k);
    if (arr) arr.push(b);
    else m.set(k, [b]);
  }
  return [...m.entries()].map(([k, v]) => [k, summarize(v)] as [string, BetSummary]).sort((a, b) => b[1].bets - a[1].bets);
}

/** Local Monday 00:00 of the week containing `ms`. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Profit per week (by settle time) for the last `weeks` weeks, oldest first. */
export function weeklyProfit(bets: Bet[], now = Date.now(), weeks = 12): { week: number; profit: number }[] {
  const cur = weekStart(now);
  const out: { week: number; profit: number }[] = [];
  // Mid-week anchor + re-normalize so DST shifts never skew a bucket.
  for (let i = weeks - 1; i >= 0; i--) out.push({ week: weekStart(cur + 3 * 86400e3 - i * 7 * 86400e3), profit: 0 });
  const idx = new Map(out.map((x, i) => [x.week, i]));
  for (const b of bets) {
    if (b.status === 'open' || !b.settledAt) continue;
    const i = idx.get(weekStart(b.settledAt));
    if (i != null) out[i].profit = cents(out[i].profit + betProfit(b));
  }
  return out;
}

/** Net loss this week (positive number, 0 when up) — for the weekly loss limit. */
export function weekLoss(bets: Bet[], now = Date.now()): number {
  const w = weekStart(now);
  const p = bets.filter((b) => b.status !== 'open' && (b.settledAt ?? 0) >= w).reduce((a, b) => a + betProfit(b), 0);
  return Math.max(0, -cents(p));
}

export function legLabel(l: Pick<BetLeg, 'market' | 'side' | 'line' | 'game'>): string {
  if (l.market === 'total') return `${l.game} ${l.side === 'over' ? 'O' : 'U'} ${l.line ?? '?'}`;
  if (l.side === 'draw') return `${l.game} Draw`;
  if (l.market === 'spread') return `${l.side} ${fmtLine(l.line)}`;
  return `${l.side} ML`;
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Neutralize spreadsheet formulas (but keep plain signed numbers), then quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function betsToCsv(bets: Bet[], bookTitle: (key: string) => string = (k) => k): string {
  const head = ['placed', 'book', 'type', 'sport', 'selection', 'odds', 'stake', 'status', 'returned', 'profit', 'settled', 'notes'];
  const rows = bets.map((b) => [
    new Date(b.placedAt).toISOString(), bookTitle(b.book), b.type, betSport(b), b.legs.map(legLabel).join(' + '), fmtAmerican(b.odds), b.stake.toFixed(2),
    b.status, b.returned?.toFixed(2) ?? '', betProfit(b).toFixed(2), b.settledAt ? new Date(b.settledAt).toISOString() : '', b.notes ?? '',
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

/** Spread line from a given team's perspective, derived from ESPN odds. */
export function spreadFor(g: SportEvent, abbr: string): number | undefined {
  const o = g.odds;
  if (!o || o.spread == null) return undefined;
  const fav = o.favoriteAbbr;
  const mag = Math.abs(o.spread);
  if (!fav) return undefined;
  return abbr === fav ? -mag : mag;
}

export function fmtLine(n: number | undefined) {
  if (n == null) return '—';
  if (n === 0) return 'PK';
  return n > 0 ? `+${n}` : `${n}`;
}

/** Sleeper uses a few different team abbreviations from ESPN. */
const SLEEPER_TO_ESPN: Record<string, string> = { WAS: 'WSH', JAC: 'JAX', LA: 'LAR' };
export const sleeperTeamToEspn = (t: string) => SLEEPER_TO_ESPN[t] ?? t;

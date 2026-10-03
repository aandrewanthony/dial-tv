import type { BetPick, League, SportEvent } from '../types';

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

// ---------- Picks / bet tracker ----------

/** Profit in units for a winning bet at the given American price (default -110). */
export function payout(units: number, price = '-110') {
  const n = parseInt(price, 10);
  if (!Number.isFinite(n) || n === 0) return units * (100 / 110);
  return n > 0 ? units * (n / 100) : units * (100 / Math.abs(n));
}

const SOCCER = new Set<League>(['mls', 'epl']);

/**
 * Grade a pick against a game. Returns undefined while the game is not final (or the
 * pick can't be graded, e.g. a spread/total pick with no line). Postponed/canceled → 'void'.
 */
export function gradePick(p: BetPick, g: SportEvent | undefined): BetPick['result'] | undefined {
  if (!g) return undefined;
  if (g.postponed || g.canceled) return 'void';
  if (g.state !== 'post' || g.completed === false || g.homeScore == null || g.awayScore == null) return undefined;
  if ((p.market === 'spread' || p.market === 'total') && p.line == null) return undefined;
  const pickedHome = p.side === g.home.abbr;
  const mine = pickedHome ? g.homeScore : g.awayScore;
  const theirs = pickedHome ? g.awayScore : g.homeScore;
  let margin: number;
  if (p.market === 'moneyline') {
    margin = mine - theirs;
    // Soccer moneyline is a 3-way market: a draw loses a team bet.
    if (margin === 0 && SOCCER.has(g.league)) return 'loss';
  } else if (p.market === 'spread') margin = mine - theirs + p.line!;
  else {
    const total = g.homeScore + g.awayScore;
    margin = p.side === 'over' ? total - p.line! : p.line! - total;
  }
  return margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push';
}

export function pickProfit(p: BetPick) {
  if (p.result === 'win') return payout(p.units, p.price);
  if (p.result === 'loss') return -p.units;
  return 0; // push, void, pending
}

export interface PickRecord {
  player: string;
  wins: number;
  losses: number;
  pushes: number;
  /** Postponed/canceled picks (no action). */
  voids: number;
  pending: number;
  units: number;
  streak: string;
}

export function recordFor(player: string, picks: BetPick[]): PickRecord {
  const mine = picks.filter((p) => p.player === player).sort((a, b) => a.createdAt - b.createdAt);
  const r: PickRecord = { player, wins: 0, losses: 0, pushes: 0, voids: 0, pending: 0, units: 0, streak: '—' };
  for (const p of mine) {
    if (p.result === 'win') r.wins++;
    else if (p.result === 'loss') r.losses++;
    else if (p.result === 'push') r.pushes++;
    else if (p.result === 'void') r.voids++;
    else r.pending++;
    r.units += pickProfit(p);
  }
  const graded = mine.filter((p) => p.result === 'win' || p.result === 'loss');
  if (graded.length) {
    const last = graded[graded.length - 1].result!;
    let n = 0;
    for (let i = graded.length - 1; i >= 0 && graded[i].result === last; i--) n++;
    r.streak = `${last === 'win' ? 'W' : 'L'}${n}`;
  }
  return r;
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

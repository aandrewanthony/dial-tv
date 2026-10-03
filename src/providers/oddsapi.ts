import type { League, SportEvent } from '../types';
import { kv } from '../store/db';
import { americanToDecimal, bestIndex, impliedProb, median, noVig, spreadFor, type LineKind } from '../lib/sports';

/**
 * The Odds API v4 (https://the-odds-api.com) — odds from many US sportsbooks side by side.
 * Free key: 500 credits/month. Each request costs (markets × regions) credits = 3 here, so we
 * cache every response in IndexedDB and only refresh on demand or on a slow timer for leagues
 * that have games in the next 24 hours. CORS: `Access-Control-Allow-Origin: *` and
 * `Access-Control-Expose-Headers: *`, so the quota headers are readable from the browser.
 */
const BASE = 'https://api.the-odds-api.com/v4';
export const ODDS_API_SIGNUP = 'https://the-odds-api.com/#get-access';
/** Leagues the API only offers futures for (college basketball): never spend credits on them. */
export const ODDS_UNSUPPORTED = new Set<League>(['ncaam']);
/** Credits one refresh of one league costs (3 markets × 1 region). */
export const CREDITS_PER_REFRESH = 3;

export const SPORT_KEYS: Record<League, string> = {
  nfl: 'americanfootball_nfl',
  ncaaf: 'americanfootball_ncaaf',
  nba: 'basketball_nba',
  wnba: 'basketball_wnba',
  ncaam: 'basketball_ncaab',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl',
  mls: 'soccer_usa_mls',
  epl: 'soccer_epl',
};

export interface BookInfo {
  key: string;
  title: string;
  /** Sportsbook home page, used when the API gives no event link. */
  home?: string;
  color: string;
}

/** Known US books, in the order the board shows them (FanDuel first). Unknown books from the API are appended. */
export const BOOKS: BookInfo[] = [
  { key: 'fanduel', title: 'FanDuel', home: 'https://sportsbook.fanduel.com/', color: '#1493ff' },
  { key: 'draftkings', title: 'DraftKings', home: 'https://sportsbook.draftkings.com/', color: '#53d337' },
  { key: 'betmgm', title: 'BetMGM', home: 'https://sports.betmgm.com/', color: '#c5a562' },
  { key: 'williamhill_us', title: 'Caesars', home: 'https://www.caesars.com/sportsbook-and-casino', color: '#b49a5d' },
  { key: 'espnbet', title: 'ESPN BET', home: 'https://espnbet.com/', color: '#ef3e42' },
  { key: 'betrivers', title: 'BetRivers', home: 'https://www.betrivers.com/', color: '#1a5cb5' },
  { key: 'fanatics', title: 'Fanatics', home: 'https://sportsbook.fanatics.com/', color: '#e01b22' },
  { key: 'hardrockbet', title: 'Hard Rock Bet', home: 'https://www.hardrock.bet/', color: '#9b59b6' },
  { key: 'ballybet', title: 'Bally Bet', home: 'https://www.ballybet.com/', color: '#e4002b' },
  { key: 'betparx', title: 'betPARX', home: 'https://www.betparx.com/', color: '#6c3fc4' },
  { key: 'fliff', title: 'Fliff', home: 'https://www.getfliff.com/', color: '#00b2ff' },
  { key: 'bovada', title: 'Bovada', home: 'https://www.bovada.lv/sports', color: '#cc0000' },
  { key: 'betonlineag', title: 'BetOnline.ag', home: 'https://www.betonline.ag/sportsbook', color: '#ffb400' },
  { key: 'lowvig', title: 'LowVig.ag', home: 'https://www.lowvig.ag/', color: '#3fa9f5' },
  { key: 'mybookieag', title: 'MyBookie.ag', home: 'https://www.mybookie.ag/sportsbook/', color: '#f7941d' },
  { key: 'betus', title: 'BetUS', home: 'https://www.betus.com.pa/sportsbook/', color: '#0055a5' },
];
const BOOK_BY_KEY = new Map(BOOKS.map((b) => [b.key, b]));
export const bookInfo = (key: string, title?: string): BookInfo => BOOK_BY_KEY.get(key) ?? { key, title: title ?? key, color: '#7d8492' };
/** The big regulated books shown by default. */
export const DEFAULT_BOOKS = ['fanduel', 'draftkings', 'betmgm', 'williamhill_us', 'espnbet', 'betrivers', 'fanatics'];

export interface Offer {
  price: number;
  point?: number;
  /** Bet-slip deep link for this outcome (includeLinks=true), when the book provides one. */
  link?: string;
}

export interface BookLine {
  book: string;
  title: string;
  updated: number;
  /** Event page link at this book. */
  link?: string;
  ml?: { home?: Offer; away?: Offer; draw?: Offer };
  spread?: { home?: Offer; away?: Offer };
  total?: { over?: Offer; under?: Offer };
}

export interface OddsEvent {
  id: string;
  league: League;
  commence: number;
  /** Full team names as the books list them, e.g. "Kansas City Chiefs". */
  home: string;
  away: string;
  books: BookLine[];
  source: 'oddsapi' | 'espn';
}

/** Only https links, with tracking/affiliate parameters stripped (we never add our own). */
export function cleanLink(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw.replace(/\{state\}/gi, ''));
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:') return undefined;
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|aff|btag|wpcid|wpsrc|clickid|irclickid|referrer|ref$|pid$|siteid$|subid)/i.test(k)) u.searchParams.delete(k);
  }
  return u.toString();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function offer(o: any): Offer | undefined {
  const price = num(o?.price);
  if (price == null || price === 0) return undefined;
  return { price, point: num(o?.point), link: cleanLink(o?.link) };
}

/** Parse a /v4/sports/{sport}/odds response (american odds, h2h/spreads/totals). */
export function parseOddsResponse(league: League, json: any): OddsEvent[] {
  if (!Array.isArray(json)) return [];
  const out: OddsEvent[] = [];
  for (const e of json) {
    const home = String(e?.home_team ?? '');
    const away = String(e?.away_team ?? '');
    const commence = Date.parse(e?.commence_time);
    if (!home || !away || !Number.isFinite(commence)) continue;
    const books: BookLine[] = [];
    for (const b of e.bookmakers ?? []) {
      const line: BookLine = { book: String(b.key), title: String(b.title ?? b.key), updated: Date.parse(b.last_update) || 0, link: cleanLink(b.link) };
      for (const m of b.markets ?? []) {
        const outcomes: any[] = m.outcomes ?? [];
        const by = (name: string) => offer(outcomes.find((o) => String(o.name).toLowerCase() === name.toLowerCase()));
        if (m.key === 'h2h') line.ml = { home: by(home), away: by(away), draw: by('Draw') };
        else if (m.key === 'spreads') line.spread = { home: by(home), away: by(away) };
        else if (m.key === 'totals') line.total = { over: by('Over'), under: by('Under') };
        if (!line.link) line.link = cleanLink(m.link);
      }
      if (line.ml || line.spread || line.total) books.push(line);
    }
    out.push({ id: String(e.id), league, commence, home, away, books, source: 'oddsapi' });
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class OddsApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface OddsFetch {
  league: League;
  at: number;
  events: OddsEvent[];
  remaining?: number;
  used?: number;
}

const cacheKey = (l: League) => `oddsapi:v1:${l}`;

export async function cachedOdds(league: League): Promise<OddsFetch | undefined> {
  return kv.get<OddsFetch>(cacheKey(league)).catch(() => undefined);
}

/** Fetch one league from The Odds API (3 credits) and cache it. */
export async function fetchLeagueOdds(league: League, apiKey: string, signal?: AbortSignal): Promise<OddsFetch> {
  const url = `${BASE}/sports/${SPORT_KEYS[league]}/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american&includeLinks=true&apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal });
  const hdr = (n: string) => {
    const v = res.headers.get(n);
    return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  const remaining = hdr('x-requests-remaining');
  const used = hdr('x-requests-used');
  if (!res.ok) {
    let msg = `Odds API error ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j?.message === 'string') msg = j.message;
    } catch {
      /* ignore */
    }
    if (res.status === 401) msg = 'The Odds API rejected the key (invalid or out of credits).';
    if (res.status === 429) msg = 'The Odds API rate limit / monthly quota was reached.';
    throw Object.assign(new OddsApiError(msg, res.status), { remaining, used });
  }
  const data: OddsFetch = { league, at: Date.now(), events: parseOddsResponse(league, await res.json()), remaining, used };
  await kv.set(cacheKey(league), data);
  return data;
}

/**
 * Which leagues are worth a (paid) refresh now: enabled leagues with a game that is live or starts
 * within 24 h, whose cache is older than `intervalMin`. Pure: unit-tested.
 */
export function leaguesDue(now: number, leagues: League[], games: SportEvent[], fetchedAt: Partial<Record<League, number>>, intervalMin: number): League[] {
  if (intervalMin <= 0) return [];
  return leagues.filter((l) => {
    if (ODDS_UNSUPPORTED.has(l)) return false;
    const soon = games.some((g) => g.league === l && (g.state === 'in' || (g.state === 'pre' && g.start - now < 24 * 3600e3 && g.start > now - 3600e3)));
    return soon && now - (fetchedAt[l] ?? 0) >= intervalMin * 60e3;
  });
}

// ---------- Matching books' events to ESPN games ----------

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function sameTeam(book: string, t: { name: string; shortName: string; abbr: string }) {
  const a = norm(book);
  const b = norm(t.name);
  if (a === b) return true;
  // "LA Clippers" vs "Los Angeles Clippers": the book name ends with ESPN's nickname ("Clippers", "Red Sox").
  const nick = norm(t.shortName);
  if (nick.length > 2 && (a.endsWith(' ' + nick) || a === nick)) return true;
  return a.length > 4 && b.length > 4 && (a.includes(b) || b.includes(a));
}

/** The ESPN game a book event is for (same league, both teams, start within 6 h). */
export function matchGame(ev: OddsEvent, games: SportEvent[]): SportEvent | undefined {
  return games.find(
    (g) => g.league === ev.league && Math.abs(g.start - ev.commence) < 6 * 3600e3 && sameTeam(ev.home, g.home) && sameTeam(ev.away, g.away),
  );
}

/** Without an Odds API key: ESPN's single-book line from the scoreboard (totals priced -110 when not given). */
export function espnOddsEvent(g: SportEvent): OddsEvent | undefined {
  const o = g.odds;
  if (!o) return undefined;
  const ml = (s?: string) => {
    const n = s ? parseInt(s, 10) : NaN;
    return Number.isFinite(n) && n !== 0 ? { price: n } : undefined;
  };
  const hs = spreadFor(g, g.home.abbr);
  const as = spreadFor(g, g.away.abbr);
  const key = norm(o.provider).replace(/ /g, '') || 'espn';
  const line: BookLine = {
    book: key === 'espnbet' ? 'espnbet' : key,
    title: o.provider || 'ESPN',
    updated: 0,
    ml: o.homeMoneyline || o.awayMoneyline ? { home: ml(o.homeMoneyline), away: ml(o.awayMoneyline) } : undefined,
    spread: hs != null && as != null ? { home: { price: -110, point: hs }, away: { price: -110, point: as } } : undefined,
    total: o.overUnder != null ? { over: { price: -110, point: o.overUnder }, under: { price: -110, point: o.overUnder } } : undefined,
  };
  if (!line.ml && !line.spread && !line.total) return undefined;
  return { id: `espn:${g.id}`, league: g.league, commence: g.start, home: g.home.name, away: g.away.name, books: [line], source: 'espn' };
}

// ---------- Board math ----------

export type Side = 'home' | 'away' | 'draw' | 'over' | 'under';
export type MarketKey = 'ml' | 'spread' | 'total';

export const offerOf = (b: BookLine, m: MarketKey, side: Side): Offer | undefined =>
  m === 'ml' ? b.ml?.[side as 'home' | 'away' | 'draw'] : m === 'spread' ? b.spread?.[side as 'home' | 'away'] : b.total?.[side as 'over' | 'under'];

const kindOf = (m: MarketKey, side: Side): LineKind => (m === 'ml' ? 'ml' : m === 'spread' ? 'spread' : side === 'over' ? 'over' : 'under');

export interface SideSummary {
  /** Index into the books array of the best line, -1 if none. */
  best: number;
  bestOffer?: Offer;
  /** Implied probability of the best price (vig included). */
  implied?: number;
  /** Consensus (median) point and price across books. */
  consensusPoint?: number;
  consensusPrice?: number;
  /** No-vig fair probability (average of each book's de-vigged market). */
  fair?: number;
}

/** Best line / consensus / no-vig fair probability for one side of one market across books. */
export function summarizeSide(books: BookLine[], m: MarketKey, side: Side): SideSummary {
  const offers = books.map((b) => offerOf(b, m, side));
  const best = bestIndex(kindOf(m, side), offers);
  const prices = offers.filter(Boolean).map((o) => o!.price);
  const points = offers.filter((o) => o?.point != null).map((o) => o!.point!);
  const sides: Side[] = m === 'ml' ? (books.some((b) => b.ml?.draw) ? ['home', 'away', 'draw'] : ['home', 'away']) : m === 'spread' ? ['home', 'away'] : ['over', 'under'];
  const fairs: number[] = [];
  for (const b of books) {
    const os = sides.map((s) => offerOf(b, m, s));
    if (os.some((o) => !o)) continue;
    // Spreads/totals only de-vig when both sides are on the same number.
    if (m !== 'ml' && (m === 'spread' ? os[0]!.point !== -(os[1]!.point ?? NaN) : os[0]!.point !== os[1]!.point)) continue;
    fairs.push(noVig(os.map((o) => o!.price))[sides.indexOf(side)]);
  }
  const bestOffer = best >= 0 ? offers[best] : undefined;
  const consensusDec = median(prices.map(americanToDecimal));
  return {
    best,
    bestOffer,
    implied: bestOffer ? impliedProb(bestOffer.price) : undefined,
    consensusPoint: median(points),
    consensusPrice: consensusDec ? (consensusDec >= 2 ? Math.round((consensusDec - 1) * 100) : Math.round(-100 / (consensusDec - 1))) : undefined,
    fair: fairs.length ? fairs.reduce((a, b) => a + b, 0) / fairs.length : undefined,
  };
}

/** Consensus numbers recorded over time for line movement. */
export interface LineSnapshot {
  at: number;
  /** Home spread (median). */
  spread?: number;
  total?: number;
  mlHome?: number;
  mlAway?: number;
}

export function snapshotOf(ev: OddsEvent, at = Date.now()): LineSnapshot {
  return {
    at,
    spread: summarizeSide(ev.books, 'spread', 'home').consensusPoint,
    total: summarizeSide(ev.books, 'total', 'over').consensusPoint,
    mlHome: summarizeSide(ev.books, 'ml', 'home').consensusPrice,
    mlAway: summarizeSide(ev.books, 'ml', 'away').consensusPrice,
  };
}

/** Append a snapshot when the consensus moved (or every 6 h to keep the line alive); keeps the last 60. */
export function pushSnapshot(list: LineSnapshot[] | undefined, s: LineSnapshot): LineSnapshot[] {
  const prev = list ?? [];
  const last = prev[prev.length - 1];
  if (last && last.spread === s.spread && last.total === s.total && last.mlHome === s.mlHome && last.mlAway === s.mlAway && s.at - last.at < 6 * 3600e3) return prev;
  if (s.spread == null && s.total == null && s.mlHome == null) return prev;
  return [...prev, s].slice(-60);
}

import type { GameOdds, GameSituation, League, SportEvent, Team } from '../types';
import type { SportsProvider } from './types';
import { safeImageUrl } from '../lib/url';

/**
 * ESPN public scoreboard adapter (site.api.espn.com). No key required and it
 * sends CORS headers, so it works from the browser and the desktop webview.
 * Date ranges are not supported by the endpoint, so we query one day at a time.
 */

const PATHS: Record<League, string> = {
  nfl: 'football/nfl',
  ncaaf: 'football/college-football',
  nba: 'basketball/nba',
  wnba: 'basketball/wnba',
  ncaam: 'basketball/mens-college-basketball',
  mlb: 'baseball/mlb',
  nhl: 'hockey/nhl',
  mls: 'soccer/usa.1',
  epl: 'soccer/eng.1',
};

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

export function ymd(d: Date) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function team(c: any): Team {
  const t = c?.team ?? {};
  return {
    id: String(t.id ?? ''),
    abbr: String(t.abbreviation ?? '???'),
    name: String(t.displayName ?? t.name ?? 'TBD'),
    shortName: String(t.shortDisplayName ?? t.name ?? t.abbreviation ?? 'TBD'),
    logo: safeImageUrl(t.logo),
    color: /^[0-9a-f]{6}$/i.test(t.color ?? '') ? `#${t.color}` : undefined,
    record: c?.records?.find((r: any) => r.type === 'total')?.summary,
  };
}

function odds(raw: any, home: Team, away: Team): GameOdds | undefined {
  const o = raw?.[0];
  if (!o) return undefined;
  let favoriteAbbr: string | undefined;
  if (o.homeTeamOdds?.favorite) favoriteAbbr = home.abbr;
  else if (o.awayTeamOdds?.favorite) favoriteAbbr = away.abbr;
  else if (typeof o.details === 'string') {
    const abbr = o.details.split(' ')[0];
    if (abbr === home.abbr || abbr === away.abbr) favoriteAbbr = abbr;
  }
  const ml = (side: 'home' | 'away') => {
    const v = o.moneyline?.[side]?.close?.odds ?? o.moneyline?.[side]?.open?.odds ?? o[`${side}TeamOdds`]?.moneyLine;
    if (v == null) return undefined;
    const s = String(v);
    return /^[+-]?\d+$/.test(s) ? (s.startsWith('-') || s.startsWith('+') ? s : `+${s}`) : undefined;
  };
  return {
    provider: String(o.provider?.name ?? 'Consensus'),
    details: typeof o.details === 'string' ? o.details : undefined,
    spread: typeof o.spread === 'number' ? o.spread : undefined,
    overUnder: typeof o.overUnder === 'number' ? o.overUnder : undefined,
    favoriteAbbr,
    homeMoneyline: ml('home'),
    awayMoneyline: ml('away'),
  };
}

function situation(s: any): GameSituation | undefined {
  if (!s) return undefined;
  return {
    text: s.downDistanceText ?? s.shortDownDistanceText,
    possessionTeamId: s.possession ? String(s.possession) : undefined,
    isRedZone: !!s.isRedZone,
    lastPlay: typeof s.lastPlay?.text === 'string' ? s.lastPlay.text : undefined,
    outs: typeof s.outs === 'number' ? s.outs : undefined,
    onBase: 'onFirst' in s ? { first: !!s.onFirst, second: !!s.onSecond, third: !!s.onThird } : undefined,
  };
}

export function parseScoreboard(league: League, json: any): SportEvent[] {
  const out: SportEvent[] = [];
  for (const e of json?.events ?? []) {
    const c = e.competitions?.[0];
    if (!c) continue;
    const homeC = c.competitors?.find((x: any) => x.homeAway === 'home');
    const awayC = c.competitors?.find((x: any) => x.homeAway === 'away');
    if (!homeC || !awayC) continue;
    const home = team(homeC);
    const away = team(awayC);
    const st = e.status ?? c.status ?? {};
    const state: SportEvent['state'] = st.type?.state === 'in' ? 'in' : st.type?.state === 'post' ? 'post' : 'pre';
    const statusName = typeof st.type?.name === 'string' ? (st.type.name as string) : undefined;
    const completed = typeof st.type?.completed === 'boolean' ? (st.type.completed as boolean) : undefined;
    const postponed = /POSTPONED/i.test(statusName ?? '');
    const canceled = /CANCEL/i.test(statusName ?? '');
    const start = Date.parse(e.date);
    const broadcasts: string[] = [];
    for (const b of c.broadcasts ?? []) for (const n of b.names ?? []) if (!broadcasts.includes(n)) broadcasts.push(n);
    for (const g of c.geoBroadcasts ?? []) {
      const n = g.media?.shortName;
      if (n && g.type?.shortName !== 'Radio' && !broadcasts.includes(n)) broadcasts.push(n);
    }
    out.push({
      id: `${league}:${e.id}`,
      league,
      start,
      state,
      statusText: state === 'pre' ? '' : String(st.type?.shortDetail ?? st.type?.detail ?? ''),
      period: Number(st.period ?? 0),
      clock: typeof st.clock === 'number' ? st.clock : undefined,
      home,
      away,
      homeScore: state === 'pre' ? undefined : Number(homeC.score ?? 0),
      awayScore: state === 'pre' ? undefined : Number(awayC.score ?? 0),
      broadcasts,
      venue: c.venue?.fullName,
      odds: odds(c.odds, home, away),
      situation: state === 'in' ? situation(c.situation) : undefined,
      week: e.week?.number,
      completed,
      statusName,
      postponed: postponed || undefined,
      canceled: canceled || undefined,
    });
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const NY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** ESPN slate date (YYYYMMDD) for an instant: ESPN files games under their US Eastern calendar date. */
export function nyDate(ms: number): string {
  const parts = NY_FMT.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/** Shift a YYYYMMDD string by whole days (calendar arithmetic, timezone-free). */
export function shiftYmd(date: string, days: number): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8) + days));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Scoreboard for an ESPN date string (YYYYMMDD). */
export async function scoreboardFor(league: League, dates: string, signal?: AbortSignal): Promise<SportEvent[]> {
  const extra = league === 'ncaaf' ? '&groups=80' : league === 'ncaam' ? '&groups=50&limit=200' : '';
  const res = await fetch(`${BASE}/${PATHS[league]}/scoreboard?dates=${dates}${extra}`, { signal });
  if (!res.ok) throw new Error(`ESPN ${league} ${res.status}`);
  return parseScoreboard(league, await res.json());
}

export const espnProvider: SportsProvider = {
  id: 'espn',
  scoreboard(league, day, signal) {
    return scoreboardFor(league, ymd(day), signal);
  },
};

/** Raw game summary (play-by-play, drives, header) for an event id like "nfl:401…"; throws when not OK. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function gameSummary(eventId: string, signal?: AbortSignal): Promise<any> {
  const [league, id] = eventId.split(':') as [League, string];
  const res = await fetch(`${BASE}/${PATHS[league]}/summary?event=${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`ESPN summary ${res.status}`);
  return res.json();
}

/** Live win probability (home %, 0–1) from the game summary endpoint, if available. */
export async function winProbability(ev: SportEvent, signal?: AbortSignal): Promise<number[] | null> {
  const [league, id] = ev.id.split(':') as [League, string];
  try {
    const res = await fetch(`${BASE}/${PATHS[league]}/summary?event=${id}`, { signal });
    if (!res.ok) return null;
    const j = await res.json();
    const wp = j?.winprobability;
    if (!Array.isArray(wp) || !wp.length) return null;
    return wp.map((x: { homeWinPercentage: number }) => x.homeWinPercentage);
  } catch {
    return null;
  }
}

const teamCache = new Map<League, Promise<Team[]>>();

/**
 * All teams in a league (for the favorite-team picker). Read from the standings
 * endpoint because the /teams endpoint does not send CORS headers.
 */
export function leagueTeams(league: League): Promise<Team[]> {
  let p = teamCache.get(league);
  if (!p) {
    p = fetch(`https://site.api.espn.com/apis/v2/sports/${PATHS[league]}/standings`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`ESPN ${r.status}`))))
      .then((j) => {
        const out = new Map<string, Team>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const walk = (n: any) => {
          for (const e of n?.standings?.entries ?? []) {
            const t = team({ team: { ...e.team, logo: e.team?.logos?.[0]?.href } });
            if (t.id) out.set(t.id, t);
          }
          for (const c of n?.children ?? []) walk(c);
        };
        walk(j);
        return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
      });
    p.catch(() => teamCache.delete(league));
    teamCache.set(league, p);
  }
  return p;
}

export interface TeamSchedule {
  team: Team & { standing?: string };
  events: SportEvent[];
  /** Bye week number (NFL). */
  byeWeek?: number;
}

/**
 * A team's season schedule (site.api.espn.com/.../teams/{id}/schedule — sends CORS `*`).
 * Its events are scoreboard-like but scores are objects and broadcasts use the geo shape,
 * so they are normalized and parsed with parseScoreboard (same ids as the live scoreboard).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseTeamSchedule(league: League, json: any): TeamSchedule {
  const t = json?.team ?? {};
  const events = (json?.events ?? []).map((e: any) => {
    const c = e?.competitions?.[0] ?? {};
    return {
      ...e,
      status: e.status ?? c.status,
      competitions: [{
        ...c,
        competitors: (c.competitors ?? []).map((x: any) => ({
          ...x,
          score: typeof x.score === 'object' && x.score ? x.score.value ?? x.score.displayValue : x.score,
          team: { ...x.team, logo: x.team?.logo ?? x.team?.logos?.[0]?.href },
        })),
        broadcasts: [],
        geoBroadcasts: c.broadcasts ?? [],
      }],
    };
  });
  const parsed = parseScoreboard(league, { events }).sort((a, b) => a.start - b.start);
  const base = team({ team: { ...t, logo: t.logo ?? t.logos?.[0]?.href } });
  return {
    team: { ...base, record: typeof t.recordSummary === 'string' ? t.recordSummary : undefined, standing: typeof t.standingSummary === 'string' ? t.standingSummary : undefined },
    events: parsed,
    byeWeek: typeof json?.byeWeek === 'number' ? json.byeWeek : undefined,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const schedCache = new Map<string, { at: number; p: Promise<TeamSchedule> }>();

export function teamSchedule(league: League, teamId: string, maxAgeMs = 10 * 60_000): Promise<TeamSchedule> {
  const key = `${league}:${teamId}`;
  const hit = schedCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.p;
  const p = fetch(`${BASE}/${PATHS[league]}/teams/${encodeURIComponent(teamId)}/schedule`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`ESPN ${r.status}`))))
    .then((j) => parseTeamSchedule(league, j));
  p.catch(() => schedCache.delete(key));
  schedCache.set(key, { at: Date.now(), p });
  return p;
}

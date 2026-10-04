/**
 * Live game feed: while you watch a live game, read ESPN's game summary (one request every 20 s,
 * only for the game on screen) and use it twice:
 *  - penalty alerts (NFL / college football / NHL): a toast with what the flag was,
 *    "Offensive Holding · MIA #P.Paul · 10 yards";
 *  - the phone remote's Game tab: fresher score, situation and the latest plays.
 * It runs only while a live game is on screen and someone needs it (penalty alerts on for a
 * football/hockey game, or a paired phone connected). Nothing runs for other channels.
 */
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/app';
import { gameSummary } from '../providers/espn';
import type { League, SportEvent } from '../types';
import type { RemoteGame, RemotePlay } from './remote';

export interface Penalty {
  id: string;
  what: string;
  team?: string;
  player?: string;
  result?: string;
  clock?: string;
  period?: number;
}

/** Leagues with penalty parsing (toasts + 🚩 on the phone). */
const PENALTY_LEAGUES: ReadonlySet<League> = new Set<League>(['nfl', 'ncaaf', 'nhl']);
export const penaltyLeague = (l: League) => PENALTY_LEAGUES.has(l);
/** Leagues whose summary carries play-by-play worth showing (soccer gets the score only). */
const FEED_LEAGUES: ReadonlySet<League> = new Set<League>(['nfl', 'ncaaf', 'nhl', 'nba', 'wnba', 'ncaam', 'mlb']);
export const feedLeague = (l: League) => FEED_LEAGUES.has(l);

const POLL_MS = 20_000;
const MAX_PLAYS = 15;

/** Football: "PENALTY on MIA-P.Paul, Offensive Holding, 10 yards, enforced at…". Hockey: "X Hooking penalty …". */
export function parsePenalty(text: string, league: League): Omit<Penalty, 'id'> | null {
  if (league === 'nhl') {
    const m = /^(.+?)\s+(\w[\w -]*?)\s*(?:\((\d+) min\)|penalty)/i.exec(text.trim());
    return m ? { what: m[2].trim(), player: m[1].trim(), result: m[3] ? `${m[3]} min` : undefined } : null;
  }
  const m = /PENALTY on ([A-Z]{2,4})-([^,]+?),\s*([^,]+?),\s*(\d+ yards?|declined|offsetting|[^,.]+)/i.exec(text);
  if (!m) return null;
  return { team: m[1], player: m[2].trim(), what: m[3].trim(), result: m[4].trim() };
}

/** "Offensive Holding · MIA · P.Paul · 10 yards" */
export const penaltyLine = (p: Omit<Penalty, 'id'>) => [p.what, p.team, p.player, p.result].filter(Boolean).join(' · ');

/** What one summary request yields. */
export interface GameFeed {
  gameId: string;
  /** Every play, newest first (penalty plays carry `penalty`). */
  plays: (RemotePlay & { flag?: Penalty })[];
  /** Score / status from the summary header when present (fresher than the scoreboard poll). */
  homeScore?: string;
  awayScore?: string;
  status?: string;
  /** Team id with the ball (football). */
  possession?: string;
  situation?: string;
  redZone?: boolean;
  hasPlays: boolean;
}

const ord = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
function periodLabel(league: League, period: any): string | undefined {
  const n = Number(period?.number);
  if (!n) return undefined;
  if (league === 'mlb') return `${({ Top: 'Top', Bottom: 'Bot', Middle: 'Mid', End: 'End' } as Record<string, string>)[period?.type] ?? 'Inn'} ${ord(n)}`;
  if (league === 'nhl') return n <= 3 ? `P${n}` : 'OT';
  if (league === 'ncaam') return n <= 2 ? `H${n}` : 'OT';
  return n <= 4 ? `Q${n}` : 'OT';
}

/** Pure: an ESPN summary JSON → feed (exported for tests). */
export function parseSummary(json: any, league: League, gameId: string): GameFeed {
  const football = league === 'nfl' || league === 'ncaaf';
  let raw: any[];
  if (football) {
    raw = [...(json?.drives?.previous ?? []).flatMap((d: any) => d?.plays ?? []), ...(json?.drives?.current?.plays ?? [])];
  } else raw = Array.isArray(json?.plays) ? json.plays : [];
  const seen = new Set<string>();
  const plays: GameFeed['plays'] = [];
  for (const p of raw) {
    const id = p?.id != null ? String(p.id) : '';
    const text = typeof p?.text === 'string' ? p.text.trim() : '';
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    // MLB lists every pitch and each new batter; keep the at-bat results and game events.
    if (league === 'mlb' && (/^pitch \d/i.test(text) || /^(start|end) batter/i.test(p.type?.text ?? ''))) continue;
    // NHL lists every faceoff and whistle.
    if (league === 'nhl' && /^(face ?off|stoppage)$/i.test(p.type?.text ?? '')) continue;
    const label = periodLabel(league, p.period);
    const clock = league === 'mlb' ? undefined : p.clock?.displayValue;
    const play: GameFeed['plays'][number] = { id, text, when: [label, clock].filter(Boolean).join(' ') || undefined, scoring: p.scoringPlay === true || undefined };
    const isFlag = league === 'nhl' ? /penalty/i.test(p.type?.text ?? '') : football && /penalty on/i.test(text);
    if (isFlag && penaltyLeague(league)) {
      const parsed = parsePenalty(text, league);
      if (parsed) {
        play.flag = { id, ...parsed, period: p.period?.number, clock: p.clock?.displayValue };
        play.penalty = penaltyLine(parsed);
      }
    }
    plays.push(play);
  }
  plays.reverse();

  const comp = json?.header?.competitions?.[0];
  const cs: any[] = Array.isArray(comp?.competitors) ? comp.competitors : [];
  const home = cs.find((c) => c?.homeAway === 'home');
  const away = cs.find((c) => c?.homeAway === 'away');
  const sit = json?.situation ?? comp?.situation;
  const holder = cs.find((c) => c?.possession === true);
  let situation: string | undefined = typeof sit?.downDistanceText === 'string' ? sit.downDistanceText : typeof sit?.shortDownDistanceText === 'string' ? sit.shortDownDistanceText : undefined;
  if (!situation && league === 'mlb' && typeof sit?.outs === 'number') situation = mlbSituation(sit);
  const score = (c: any) => (c?.score != null && c.score !== '' ? String(c.score) : undefined);
  return {
    gameId,
    plays,
    hasPlays: raw.length > 0,
    homeScore: score(home),
    awayScore: score(away),
    status: typeof comp?.status?.type?.shortDetail === 'string' ? comp.status.type.shortDetail : undefined,
    possession: holder?.id != null ? String(holder.id) : sit?.possession != null ? String(sit.possession) : undefined,
    situation,
    redZone: sit?.isRedZone === true || undefined,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function mlbSituation(s: { outs?: number; onFirst?: unknown; onSecond?: unknown; onThird?: unknown }): string {
  const bases = [s.onFirst && '1st', s.onSecond && '2nd', s.onThird && '3rd'].filter(Boolean);
  return `${s.outs} out${s.outs === 1 ? '' : 's'}${bases.length ? ` · on ${bases.join(', ')}` : ''}`;
}

/**
 * The one poller for the game on screen. Toasts each new flag when penalty alerts are on (flags
 * already thrown when you tune in are skipped) and returns the latest feed for the phone.
 * `phone`: a paired phone is connected (it wants the feed for any league with plays).
 */
export function useGameFeed(game: SportEvent | undefined, phone: boolean): GameFeed | undefined {
  const alertsOn = useApp((s) => s.settings.penaltyAlerts !== false);
  const league = game?.id.split(':')[0] as League | undefined;
  const live = !!game && game.state === 'in' && !!league;
  const wantAlerts = live && alertsOn && penaltyLeague(league!);
  const wantFeed = live && phone && feedLeague(league!);
  const gameId = wantAlerts || wantFeed ? game!.id : undefined;
  const [feed, setFeed] = useState<GameFeed>();
  const alertsRef = useRef(wantAlerts);
  alertsRef.current = wantAlerts;
  const phoneRef = useRef(wantFeed);
  phoneRef.current = wantFeed;
  // Flags already handled for this game (kept when the poller restarts, e.g. a phone connects).
  const seen = useRef<{ game?: string; ids: Set<string>; primed: boolean }>({ ids: new Set(), primed: false });

  useEffect(() => {
    if (!gameId) return;
    if (seen.current.game !== gameId) seen.current = { game: gameId, ids: new Set(), primed: false };
    const lg = gameId.split(':')[0] as League;
    const ctl = new AbortController();
    const tick = async () => {
      if (document.hidden && !phoneRef.current) return;
      try {
        const next = parseSummary(await gameSummary(gameId, ctl.signal), lg, gameId);
        if (ctl.signal.aborted) return;
        const s = seen.current;
        for (const p of next.plays) {
          if (!p.flag || s.ids.has(p.id)) continue;
          s.ids.add(p.id);
          if (!s.primed || !alertsRef.current) continue;
          const f = p.flag;
          useApp.getState().toast({
            kind: 'info',
            title: `🚩 ${f.what}`,
            body: [f.team && f.player ? `${f.team} · ${f.player}` : f.player, f.result].filter(Boolean).join(' · '),
            ttl: 9000,
          });
        }
        s.primed = true;
        setFeed(next);
      } catch { /* offline or aborted: try again next tick */ }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => { ctl.abort(); clearInterval(t); };
  }, [gameId, wantFeed]);

  return feed && game && feed.gameId === game.id ? feed : undefined;
}

/** What the phone's Game tab shows: score bug + latest plays (teams only under the spoiler shield). */
export function remoteGame(g: SportEvent, feed: GameFeed | undefined, reveal: boolean): RemoteGame {
  const league = g.league;
  const possId = feed?.possession ?? g.situation?.possessionTeamId;
  const side = (t: SportEvent['home'], score: string | undefined) => ({
    abbr: t.abbr,
    name: t.shortName || t.name,
    color: t.color,
    ...(reveal ? { score, poss: !!possId && possId === t.id } : {}),
  });
  const fromEvent = (n: number | undefined) => (n == null ? undefined : String(n));
  const sit = g.situation;
  const eventSituation = sit?.text ?? (league === 'mlb' && typeof sit?.outs === 'number'
    ? mlbSituation({ outs: sit.outs, onFirst: sit.onBase?.first, onSecond: sit.onBase?.second, onThird: sit.onBase?.third })
    : undefined);
  if (!reveal) {
    return { id: g.id, league, away: side(g.away, undefined), home: side(g.home, undefined), status: 'Spoiler shield on', hidden: true, feed: false, plays: [] };
  }
  return {
    id: g.id,
    league,
    away: side(g.away, feed?.awayScore ?? fromEvent(g.awayScore)),
    home: side(g.home, feed?.homeScore ?? fromEvent(g.homeScore)),
    status: feed?.status ?? g.statusText,
    situation: feed?.situation ?? eventSituation,
    redZone: feed?.redZone ?? sit?.isRedZone ?? undefined,
    feed: feedLeague(league) && (!feed || feed.hasPlays),
    plays: (feed?.plays ?? []).slice(0, MAX_PLAYS).map(({ id, text, when, scoring, penalty }) => ({ id, text: text.slice(0, 400), when, scoring, penalty })),
  };
}

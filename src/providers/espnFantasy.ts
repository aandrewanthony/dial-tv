import type { FantasyMatchup, FantasyPlayer, FantasySnapshot, FantasyTeam } from './types';
import { hasSecret, secretsAreEncrypted, setSecret } from '../lib/secrets';

/**
 * ESPN Fantasy Football (read-only). Public leagues work from the browser: lm-api-reads sends
 * `Access-Control-Allow-Origin: <origin>` + `Allow-Credentials: true`.
 *
 * Private leagues need the user's espn_s2 / SWID cookies. A page can't attach those (Cookie is a
 * forbidden header), so they're desktop-only: the user pastes them once, they're saved encrypted with
 * the OS keychain as write-only secrets, and the shell (electron/espnAuth.cjs + main.cjs) adds them to
 * the app's own requests to lm-api-reads.fantasy.espn.com / fantasy.espn.com. The renderer never
 * reads them back, and never asks for the ESPN password.
 */
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

/** Secret names (must match electron/espnAuth.cjs). */
export const ESPN_S2_SECRET = 'espn_s2';
export const ESPN_SWID_SECRET = 'espn_swid';

/** espn_s2 as pasted (maybe "espn_s2=…" or quoted) → bare value, or null. Same rules as the shell. */
export function cleanEspnS2(raw: string): string | null {
  const v = raw.trim().replace(/^espn_s2\s*=\s*/i, '').replace(/^"(.*)"$/, '$1').trim();
  return /^[A-Za-z0-9%+/=._~-]{20,2048}$/.test(v) ? v : null;
}

/** SWID as pasted ({GUID}, GUID or "SWID=…") → "{GUID}" uppercase, or null. */
export function cleanSwid(raw: string): string | null {
  const v = raw.trim().replace(/^swid\s*=\s*/i, '').replace(/^"(.*)"$/, '$1').trim().replace(/^\{|\}$/g, '');
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(v) ? `{${v.toUpperCase()}}` : null;
}

/** Private leagues need the desktop app (the shell attaches the cookies; a browser page can't). */
export const espnPrivateSupported = () => secretsAreEncrypted();

export async function hasEspnCookies(): Promise<boolean> {
  if (!espnPrivateSupported()) return false;
  const [a, b] = await Promise.all([hasSecret(ESPN_S2_SECRET), hasSecret(ESPN_SWID_SECRET)]);
  return a && b;
}

/** Validate and save both cookies in the OS keychain. Returns an error message, or undefined when saved. */
export async function saveEspnCookies(s2Raw: string, swidRaw: string): Promise<string | undefined> {
  if (!espnPrivateSupported()) return 'Private ESPN leagues need the Dial TV desktop app.';
  const s2 = cleanEspnS2(s2Raw);
  const swid = cleanSwid(swidRaw);
  if (!s2) return 'That doesn’t look like an espn_s2 value — copy the whole Value column (a long string of letters, numbers and % signs).';
  if (!swid) return 'That doesn’t look like a SWID — it’s a code in braces like {1A2B3C4D-…}.';
  const ok = (await setSecret(ESPN_S2_SECRET, s2)) && (await setSecret(ESPN_SWID_SECRET, swid));
  return ok ? undefined : 'Couldn’t save the cookies to your keychain.';
}

export async function clearEspnCookies(): Promise<void> {
  await Promise.all([setSecret(ESPN_S2_SECRET, null), setSecret(ESPN_SWID_SECRET, null)]);
}

/** ESPN proTeamId → ESPN NFL abbreviation (same as the scoreboard uses). */
export const PRO_TEAMS: Record<number, string> = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV',
  14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF',
  26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};

const POSITIONS: Record<number, string> = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 7: 'P', 9: 'DT', 10: 'DE', 11: 'LB', 12: 'CB', 13: 'S', 14: 'HC', 16: 'D/ST' };

/** Lineup slot id → label and display order. 20 = bench, 21 = IR. */
const SLOTS: Record<number, [string, number]> = {
  0: ['QB', 0], 1: ['TQB', 1], 2: ['RB', 2], 3: ['RB/WR', 5], 4: ['WR', 3], 5: ['WR/TE', 6], 6: ['TE', 4], 7: ['OP', 7], 23: ['FLEX', 8],
  16: ['D/ST', 10], 17: ['K', 11], 18: ['P', 12], 19: ['HC', 13], 8: ['DT', 14], 9: ['DE', 15], 10: ['LB', 16], 11: ['DL', 17],
  12: ['CB', 18], 13: ['S', 19], 14: ['DB', 20], 15: ['DP', 21], 24: ['ER', 22],
};
const BENCH = 20;
const IR = 21;

/** 'private': the league needs cookies we don't have. 'auth': the saved cookies were rejected (expired / not in the league). */
export type EspnErrorCode = 'private' | 'auth' | 'notfound' | 'other';

export class EspnFantasyError extends Error {
  constructor(message: string, readonly status: number, readonly code: EspnErrorCode = 'other') {
    super(message);
  }
}

export interface EspnFetchOptions {
  signal?: AbortSignal;
  /** The league is connected as private (the desktop shell attaches the saved cookies). */
  private?: boolean;
  /** Test seam (defaults to the global fetch). */
  fetch?: typeof fetch;
}

const MAKE_PUBLIC = 'the commissioner can turn on “Make League Viewable to Public” (League → Settings → Basic Settings)';
const EXPIRED =
  'ESPN didn’t accept your saved espn_s2 / SWID cookies — they’ve probably expired (signing out of espn.com resets them), or that ESPN account isn’t in this league. Sign in on espn.com, copy fresh values and save them again.';

function privateError(status: number, isPrivate: boolean): EspnFantasyError {
  if (isPrivate) return new EspnFantasyError(EXPIRED, status, 'auth');
  const how = espnPrivateSupported()
    ? `Choose “Private league” and add your ESPN cookies, or ${MAKE_PUBLIC}.`
    : `Private leagues need the Dial TV desktop app — or ${MAKE_PUBLIC}.`;
  return new EspnFantasyError(`This ESPN league is private. ${how}`, status, 'private');
}

/** NFL fantasy season for a date: the season that started in the fall (Jan–Feb belong to the previous year). */
export const espnSeason = (now = new Date()) => String(now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear());

export function leagueUrl(leagueId: string, season: string) {
  return `${BASE}/seasons/${encodeURIComponent(season)}/segments/0/leagues/${encodeURIComponent(leagueId)}?view=mMatchupScore&view=mTeam&view=mRoster&view=mSettings`;
}

export async function fetchEspnLeague(leagueId: string, season: string, opts: EspnFetchOptions = {}): Promise<unknown> {
  if (!/^\d{1,12}$/.test(leagueId.trim())) throw new EspnFantasyError('ESPN league ids are numbers — copy it from the leagueId= part of your league URL.', 400);
  const isPrivate = !!opts.private;
  if (isPrivate && !espnPrivateSupported()) throw new EspnFantasyError('This league is connected as a private ESPN league, which needs the Dial TV desktop app.', 0, 'private');
  const res = await (opts.fetch ?? fetch)(leagueUrl(leagueId.trim(), season), { signal: opts.signal });
  if (res.status === 401 || res.status === 403) throw privateError(res.status, isPrivate);
  if (res.status === 404) throw new EspnFantasyError(`No ESPN league ${leagueId} for the ${season} season.`, 404, 'notfound');
  if (!res.ok) throw new EspnFantasyError(`ESPN Fantasy error ${res.status}`, res.status);
  // Bad cookies can also come back as an HTML sign-in page or an error body instead of a 401.
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    if (isPrivate) throw new EspnFantasyError(EXPIRED, res.status, 'auth');
    throw new EspnFantasyError('ESPN Fantasy sent back something that isn’t league data. Try again in a minute.', res.status);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = json as any;
  if (!j || typeof j !== 'object' || Array.isArray(j) || (!Array.isArray(j.teams) && (j.messages || j.details))) {
    const authish = JSON.stringify(j?.details ?? j?.messages ?? '').match(/AUTH|not authorized|private/i);
    if (authish) throw privateError(401, isPrivate);
    throw new EspnFantasyError('ESPN Fantasy sent back something that isn’t league data. Try again in a minute.', res.status);
  }
  return j;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const teamName = (t: any) => String(t?.name || [t?.location, t?.nickname].filter(Boolean).join(' ') || t?.abbrev || `Team ${t?.id}`);

function statFor(player: any, week: number, source: 0 | 1): number | undefined {
  const s = (player?.stats ?? []).find((x: any) => x.scoringPeriodId === week && x.statSourceId === source && (x.statSplitTypeId ?? 1) === 1);
  return typeof s?.appliedTotal === 'number' ? Math.round(s.appliedTotal * 100) / 100 : undefined;
}

/** Parse an ESPN league (views mMatchupScore, mTeam, mRoster, mSettings) into the app's fantasy shape. */
export function parseEspnLeague(json: any, myTeamId?: string): FantasySnapshot {
  const season = String(json?.seasonId ?? '');
  const week = Number(json?.scoringPeriodId ?? json?.status?.latestScoringPeriod ?? 1) || 1;
  const matchupPeriod = Number(json?.status?.currentMatchupPeriod ?? week) || week;
  const members = new Map<string, any>((json?.members ?? []).map((m: any) => [String(m.id), m]));
  const ownerOf = (t: any) => {
    const m = members.get(String(t?.primaryOwner ?? t?.owners?.[0] ?? ''));
    return String(m?.displayName || [m?.firstName, m?.lastName].filter(Boolean).join(' ') || 'Unknown');
  };
  const players: Record<string, FantasyPlayer> = {};
  const teams = new Map<string, FantasyTeam>();
  for (const t of json?.teams ?? []) {
    const starters: { id: string; order: number; slot: string }[] = [];
    const bench: string[] = [];
    const playerPoints: Record<string, number> = {};
    const playerProjections: Record<string, number> = {};
    for (const e of t.roster?.entries ?? []) {
      const p = e.playerPoolEntry?.player ?? {};
      const id = String(e.playerId ?? p.id);
      const pos = POSITIONS[p.defaultPositionId] ?? '?';
      players[id] = {
        id,
        name: String(p.fullName ?? id),
        position: pos,
        team: PRO_TEAMS[p.proTeamId],
        injury: p.injuryStatus && p.injuryStatus !== 'ACTIVE' ? String(p.injuryStatus) : undefined,
      };
      const pts = statFor(p, week, 0);
      const proj = statFor(p, week, 1);
      if (pts != null) playerPoints[id] = pts;
      if (proj != null) playerProjections[id] = proj;
      const slot = Number(e.lineupSlotId);
      if (slot === BENCH || slot === IR) bench.push(id);
      else starters.push({ id, order: SLOTS[slot]?.[1] ?? 50, slot: SLOTS[slot]?.[0] ?? pos });
    }
    starters.sort((a, b) => a.order - b.order);
    const id = String(t.id);
    teams.set(id, {
      rosterId: Number(t.id),
      ownerName: ownerOf(t),
      teamName: teamName(t),
      starters: starters.map((s) => s.id),
      slots: Object.fromEntries(starters.map((s) => [s.id, s.slot])),
      bench,
      points: starters.reduce((a, s) => a + (playerPoints[s.id] ?? 0), 0),
      playerPoints,
      playerProjections,
      projected: starters.reduce((a, s) => a + (playerProjections[s.id] ?? playerPoints[s.id] ?? 0), 0),
    });
  }
  // Official live totals from the schedule when present.
  const games = (json?.schedule ?? []).filter((m: any) => Number(m.matchupPeriodId) === matchupPeriod);
  for (const m of games) {
    for (const side of [m.home, m.away]) {
      const t = side && teams.get(String(side.teamId));
      const total = side?.totalPointsLive ?? side?.totalPoints;
      if (t && typeof total === 'number' && (total > 0 || t.points === 0)) t.points = Math.round(total * 100) / 100;
    }
  }
  let matchup: FantasyMatchup | undefined;
  const me = myTeamId ? teams.get(myTeamId) : undefined;
  if (me) {
    const m = games.find((x: any) => String(x.home?.teamId) === myTeamId || String(x.away?.teamId) === myTeamId);
    const oppId = m ? String(String(m.home?.teamId) === myTeamId ? m.away?.teamId ?? '' : m.home?.teamId) : '';
    matchup = { week, me, opponent: oppId ? teams.get(oppId) : undefined };
  }
  return {
    week,
    season,
    league: { id: String(json?.id ?? ''), name: String(json?.settings?.name ?? `ESPN league ${json?.id ?? ''}`), season },
    teams: [...teams.entries()].map(([id, t]) => ({ id, name: t.teamName, owner: t.ownerName })),
    matchup,
    players,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function espnSnapshot(leagueId: string, season: string, myTeamId?: string, opts: EspnFetchOptions = {}): Promise<FantasySnapshot> {
  return parseEspnLeague(await fetchEspnLeague(leagueId, season, opts), myTeamId);
}

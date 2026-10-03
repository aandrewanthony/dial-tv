import type { FantasyMatchup, FantasyPlayer, FantasySnapshot, FantasyTeam } from './types';

/**
 * ESPN Fantasy Football (read-only). Public leagues work from the browser: lm-api-reads sends
 * `Access-Control-Allow-Origin: <origin>` + `Allow-Credentials: true`. Private leagues need the
 * espn_s2 / SWID cookies, which a page cannot attach (Cookie is a forbidden header and the app has
 * no ESPN session), so the UI asks for the league to be set to public. If the desktop shell ever
 * stores those cookies for .espn.com, adding `credentials: 'include'` to the fetch below would pick them up.
 */
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

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

export class EspnFantasyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** NFL fantasy season for a date: the season that started in the fall (Jan–Feb belong to the previous year). */
export const espnSeason = (now = new Date()) => String(now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear());

export function leagueUrl(leagueId: string, season: string) {
  return `${BASE}/seasons/${encodeURIComponent(season)}/segments/0/leagues/${encodeURIComponent(leagueId)}?view=mMatchupScore&view=mTeam&view=mRoster&view=mSettings`;
}

export async function fetchEspnLeague(leagueId: string, season: string, signal?: AbortSignal): Promise<unknown> {
  if (!/^\d{1,12}$/.test(leagueId.trim())) throw new EspnFantasyError('ESPN league ids are numbers — copy it from the leagueId= part of your league URL.', 400);
  const res = await fetch(leagueUrl(leagueId.trim(), season), { signal });
  if (res.status === 401 || res.status === 403) {
    throw new EspnFantasyError('This ESPN league is private. Ask the commissioner to make it viewable to the public (League → Settings → Basic Settings → "Make League Viewable to Public"), then try again.', res.status);
  }
  if (res.status === 404) throw new EspnFantasyError(`No ESPN league ${leagueId} for the ${season} season.`, 404);
  if (!res.ok) throw new EspnFantasyError(`ESPN Fantasy error ${res.status}`, res.status);
  return res.json();
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

export async function espnSnapshot(leagueId: string, season: string, myTeamId?: string, signal?: AbortSignal): Promise<FantasySnapshot> {
  return parseEspnLeague(await fetchEspnLeague(leagueId, season, signal), myTeamId);
}

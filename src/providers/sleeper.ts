import type { FantasyPlayer, FantasyProvider, FantasyTeam } from './types';
import { sleeperTeamToEspn } from '../lib/sports';
import { kv } from '../store/db';

/**
 * Sleeper fantasy adapter. Sleeper's API is public and read-only: a username is
 * all that's needed, no password or token. https://docs.sleeper.com
 */
const BASE = 'https://api.sleeper.app/v1';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`Sleeper ${res.status} for ${path}`);
  const j = await res.json();
  if (j == null) throw new Error('Not found');
  return j as T;
}

const PLAYERS_KEY = 'sleeper:players:v1';
const DAY = 24 * 3600_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
export const sleeperProvider: FantasyProvider = {
  id: 'sleeper',
  async findUser(username) {
    const u = await get<any>(`/user/${encodeURIComponent(username.trim())}`);
    return { userId: String(u.user_id), displayName: String(u.display_name ?? username) };
  },
  async leagues(userId, season) {
    const ls = await get<any[]>(`/user/${userId}/leagues/nfl/${season}`);
    return ls.map((l) => ({ id: String(l.league_id), name: String(l.name), season: String(l.season), avatar: l.avatar ? `https://sleepercdn.com/avatars/thumbs/${l.avatar}` : undefined }));
  },
  async currentWeek() {
    const s = await get<any>('/state/nfl');
    return { week: Math.max(1, Number(s.display_week ?? s.week ?? 1)), season: String(s.season) };
  },
  async matchup(leagueId, userId, week) {
    const [rosters, users, matchups] = await Promise.all([
      get<any[]>(`/league/${leagueId}/rosters`),
      get<any[]>(`/league/${leagueId}/users`),
      get<any[]>(`/league/${leagueId}/matchups/${week}`),
    ]);
    const userById = new Map(users.map((u) => [String(u.user_id), u]));
    const teamFor = (rosterId: number): FantasyTeam => {
      const r = rosters.find((x) => x.roster_id === rosterId);
      const m = matchups.find((x) => x.roster_id === rosterId);
      const u = userById.get(String(r?.owner_id));
      return {
        rosterId,
        ownerName: String(u?.display_name ?? 'Unknown'),
        teamName: String(u?.metadata?.team_name || u?.display_name || `Team ${rosterId}`),
        starters: (m?.starters ?? r?.starters ?? []).filter((s: string) => s && s !== '0').map(String),
        points: Number(m?.points ?? 0),
        playerPoints: m?.players_points ?? {},
      };
    };
    const mine = rosters.find((r) => String(r.owner_id) === userId || (r.co_owners ?? []).map(String).includes(userId));
    if (!mine) throw new Error('You do not have a roster in this league');
    const myM = matchups.find((x) => x.roster_id === mine.roster_id);
    const oppM = myM?.matchup_id != null ? matchups.find((x) => x.matchup_id === myM.matchup_id && x.roster_id !== mine.roster_id) : undefined;
    return { week, me: teamFor(mine.roster_id), opponent: oppM ? teamFor(oppM.roster_id) : undefined };
  },
  async players() {
    // ~5 MB payload; Sleeper asks clients to fetch it at most once per day.
    const cached = await kv.get<{ at: number; players: Record<string, FantasyPlayer> }>(PLAYERS_KEY).catch(() => undefined);
    if (cached && Date.now() - cached.at < DAY) return cached.players;
    try {
      const raw = await get<Record<string, any>>('/players/nfl');
      const players: Record<string, FantasyPlayer> = {};
      for (const [id, p] of Object.entries(raw)) {
        if (!p || (!p.active && p.position !== 'DEF')) continue;
        players[id] = {
          id,
          name: p.position === 'DEF' ? `${p.first_name ?? ''} ${p.last_name ?? ''} D/ST`.trim() : String(p.full_name ?? `${p.first_name} ${p.last_name}`),
          position: String(p.position ?? '?'),
          team: p.team ? sleeperTeamToEspn(String(p.team)) : undefined,
        };
      }
      await kv.set(PLAYERS_KEY, { at: Date.now(), players });
      return players;
    } catch (e) {
      if (cached) return cached.players;
      throw e;
    }
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

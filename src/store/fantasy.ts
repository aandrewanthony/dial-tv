import { create } from 'zustand';
import type { FantasyLeague, FantasyMatchup, FantasyPlayer } from '../providers/types';
import { sleeperProvider } from '../providers/sleeper';
import type { SportEvent } from '../types';
import { useApp, type FantasyConfig } from './app';

interface FantasyState {
  players: Record<string, FantasyPlayer>;
  leagues: FantasyLeague[];
  matchup?: FantasyMatchup;
  week?: number;
  season?: string;
  loading: boolean;
  error?: string;
  updated?: number;
  refresh: () => Promise<void>;
}

const DAY = 24 * 3600_000;
/** `${userId}|${season}` → leagues */
const leagueCache = new Map<string, FantasyLeague[]>();
/** Player DB per season, refreshed daily (the provider also caches it in IndexedDB). */
let playerCache: { season: string; at: number; players: Record<string, FantasyPlayer> } | undefined;

const cfgKey = (c: FantasyConfig | undefined) => (c ? `${c.provider}|${c.userId}|${c.leagueId ?? ''}` : '');

let inflight: Promise<void> | null = null;
let rerun = false;

/** Test hook: forget cached leagues/players. */
export function resetFantasyCaches() {
  leagueCache.clear();
  playerCache = undefined;
}

export const useFantasy = create<FantasyState>((set) => {
  async function runOnce() {
    const cfg = useApp.getState().fantasy;
    if (!cfg) {
      set({ matchup: undefined, leagues: [], loading: false });
      return;
    }
    const key = cfgKey(cfg);
    set({ loading: true, error: undefined });
    try {
      const { week, season } = await sleeperProvider.currentWeek();
      const lk = `${cfg.userId}|${season}`;
      const [players, leagues] = await Promise.all([
        playerCache && playerCache.season === season && Date.now() - playerCache.at < DAY
          ? Promise.resolve(playerCache.players)
          : sleeperProvider.players().then((p) => {
              playerCache = { season, at: Date.now(), players: p };
              return p;
            }),
        leagueCache.get(lk)
          ? Promise.resolve(leagueCache.get(lk)!)
          : sleeperProvider.leagues(cfg.userId, season).then((l) => {
              leagueCache.set(lk, l);
              return l;
            }),
      ]);
      const matchup = cfg.leagueId ? await sleeperProvider.matchup(cfg.leagueId, cfg.userId, week) : undefined;
      // Config changed while we were loading: drop this result and load again.
      if (cfgKey(useApp.getState().fantasy) !== key) {
        rerun = true;
        return;
      }
      set({ players, leagues, matchup, week, season, loading: false, updated: Date.now() });
    } catch (e) {
      if (cfgKey(useApp.getState().fantasy) !== key) {
        rerun = true;
        return;
      }
      set({ loading: false, error: (e as Error).message });
    }
  }

  return {
    players: {},
    leagues: [],
    loading: false,
    refresh: () => {
      if (inflight) {
        // A refresh is running: queue one more pass so a config change mid-load is picked up.
        rerun = true;
        return inflight;
      }
      inflight = (async () => {
        try {
          do {
            rerun = false;
            await runOnce();
          } while (rerun);
        } finally {
          inflight = null;
          set({ loading: false });
        }
      })();
      return inflight;
    },
  };
});

export interface GameStakes {
  mine: FantasyPlayer[];
  theirs: FantasyPlayer[];
  /** Simple weight: each starter in the game counts; your guys count a bit more. */
  score: number;
}

/** For each game, which of my starters and my opponent's starters are playing in it. */
export function stakesByGame(
  games: SportEvent[],
  matchup: FantasyMatchup | undefined,
  players: Record<string, FantasyPlayer>,
): Map<string, GameStakes> {
  const out = new Map<string, GameStakes>();
  if (!matchup) return out;
  const byTeam = (ids: string[]) => {
    const m = new Map<string, FantasyPlayer[]>();
    for (const id of ids) {
      const p = players[id];
      if (!p?.team) continue;
      const arr = m.get(p.team);
      if (arr) arr.push(p);
      else m.set(p.team, [p]);
    }
    return m;
  };
  const mine = byTeam(matchup.me.starters);
  const theirs = byTeam(matchup.opponent?.starters ?? []);
  for (const g of games) {
    if (g.league !== 'nfl') continue;
    const m = [...(mine.get(g.home.abbr) ?? []), ...(mine.get(g.away.abbr) ?? [])];
    const t = [...(theirs.get(g.home.abbr) ?? []), ...(theirs.get(g.away.abbr) ?? [])];
    if (m.length || t.length) out.set(g.id, { mine: m, theirs: t, score: m.length * 1.25 + t.length });
  }
  return out;
}

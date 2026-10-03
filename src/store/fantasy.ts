import { create } from 'zustand';
import type { FantasyLeague, FantasyMatchup, FantasyPlayer } from '../providers/types';
import { sleeperProvider } from '../providers/sleeper';
import type { SportEvent } from '../types';
import { useApp } from './app';

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

export const useFantasy = create<FantasyState>((set, get) => ({
  players: {},
  leagues: [],
  loading: false,
  refresh: async () => {
    const cfg = useApp.getState().fantasy;
    if (!cfg || get().loading) return;
    set({ loading: true, error: undefined });
    try {
      const { week, season } = await sleeperProvider.currentWeek();
      const [players, leagues] = await Promise.all([
        Object.keys(get().players).length ? Promise.resolve(get().players) : sleeperProvider.players(),
        get().leagues.length ? Promise.resolve(get().leagues) : sleeperProvider.leagues(cfg.userId, season),
      ]);
      const matchup = cfg.leagueId ? await sleeperProvider.matchup(cfg.leagueId, cfg.userId, week) : undefined;
      set({ players, leagues, matchup, week, season, loading: false, updated: Date.now() });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },
}));

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
      m.set(p.team, [...(m.get(p.team) ?? []), p]);
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

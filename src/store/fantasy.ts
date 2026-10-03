import { create } from 'zustand';
import type { FantasyLeague, FantasyMatchup, FantasyPlayer, FantasySnapshot } from '../providers/types';
import { sleeperProvider } from '../providers/sleeper';
import { espnSeason, espnSnapshot } from '../providers/espnFantasy';
import type { SportEvent } from '../types';
import { useApp, type FantasyConfig, type FantasyPlatform } from './app';

interface FantasyState {
  players: Record<string, FantasyPlayer>;
  /** Sleeper: the user's leagues this season. ESPN: just the connected league. */
  leagues: FantasyLeague[];
  /** Teams in the connected league (ESPN: to choose yours). */
  teams: FantasySnapshot['teams'];
  matchup?: FantasyMatchup;
  week?: number;
  season?: string;
  platform?: FantasyPlatform;
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

const cfgKey = (c: FantasyConfig | undefined) => (c ? `${c.provider}|${c.userId}|${c.leagueId ?? ''}|${c.season ?? ''}` : '');

let inflight: Promise<void> | null = null;
let rerun = false;

/** Test hook: forget cached leagues/players. */
export function resetFantasyCaches() {
  leagueCache.clear();
  playerCache = undefined;
}

type Loaded = Omit<FantasySnapshot, 'league'> & { leagues: FantasyLeague[] };

/**
 * One adapter per platform: turns the saved config into this week's snapshot.
 * Phase 2 seam: a Dial TV-hosted league adds a 'dialtv' adapter here (and to FantasyPlatform in app.ts);
 * the pages, red-zone alerts, stakes and scheduler only read the normalized FantasySnapshot shape.
 */
const ADAPTERS: Record<FantasyPlatform, (cfg: FantasyConfig) => Promise<Loaded>> = {
  async sleeper(cfg) {
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
    return { week, season, players, leagues, matchup, teams: [] };
  },
  async espn(cfg) {
    if (!cfg.leagueId) throw new Error('No ESPN league connected');
    const snap = await espnSnapshot(cfg.leagueId, cfg.season ?? espnSeason(), cfg.userId || undefined);
    return { ...snap, leagues: [snap.league] };
  },
};

export const useFantasy = create<FantasyState>((set) => {
  async function runOnce() {
    const cfg = useApp.getState().fantasy;
    if (!cfg) {
      set({ matchup: undefined, leagues: [], teams: [], loading: false, platform: undefined });
      return;
    }
    const key = cfgKey(cfg);
    set({ loading: true, error: undefined });
    try {
      const r = await ADAPTERS[cfg.provider](cfg);
      // Config changed while we were loading: drop this result and load again.
      if (cfgKey(useApp.getState().fantasy) !== key) {
        rerun = true;
        return;
      }
      set({ players: r.players, leagues: r.leagues, teams: r.teams, matchup: r.matchup, week: r.week, season: r.season, platform: cfg.provider, loading: false, updated: Date.now() });
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
    teams: [],
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

export interface StartSitHint {
  benchId: string;
  starterId: string;
  gain: number;
}

/**
 * Simple start/sit hints from projections: a bench player projected higher than a starter at the same
 * position whose game hasn't started. Only for platforms that report projections (ESPN).
 */
export function startSitHints(m: FantasyMatchup | undefined, players: Record<string, FantasyPlayer>, notStarted: (team?: string) => boolean): StartSitHint[] {
  const t = m?.me;
  if (!t?.bench?.length || !t.playerProjections) return [];
  const proj = t.playerProjections;
  const out: StartSitHint[] = [];
  const used = new Set<string>();
  for (const b of t.bench) {
    const bp = players[b];
    if (!bp || proj[b] == null || bp.injury === 'OUT' || !notStarted(bp.team)) continue;
    let best: StartSitHint | undefined;
    for (const s of t.starters) {
      const sp = players[s];
      if (!sp || used.has(s) || sp.position !== bp.position || !notStarted(sp.team)) continue;
      const gain = proj[b] - (proj[s] ?? 0);
      if (gain >= 2 && (!best || gain > best.gain)) best = { benchId: b, starterId: s, gain: Math.round(gain * 10) / 10 };
    }
    if (best) {
      used.add(best.starterId);
      out.push(best);
    }
  }
  return out.sort((a, b) => b.gain - a.gain);
}

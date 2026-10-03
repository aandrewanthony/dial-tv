import { useMemo } from 'react';
import { useApp } from '../store/app';
import { stakesByGame, useFantasy, type GameStakes } from '../store/fantasy';
import { clutchInfo } from '../lib/sports';
import type { SportEvent } from '../types';

export interface RankedGame {
  g: SportEvent;
  stakes?: GameStakes;
  watch: number;
  reasons: string[];
}

/**
 * "Watchability" ranking: blends how close/late a game is, your fantasy exposure,
 * and whether one of your favorite teams is playing.
 */
export function useRankedGames(filter: (g: SportEvent) => boolean = () => true): RankedGame[] {
  const games = useApp((s) => s.games);
  const favTeams = useApp((s) => s.favTeams);
  const matchup = useFantasy((s) => s.matchup);
  const players = useFantasy((s) => s.players);
  // Rank everything once per data change; the (cheap) filter runs every render so callers can close over state.
  const ranked = useMemo(() => {
    const list = Object.values(games);
    const stakes = stakesByGame(list, matchup, players);
    return list
      .map((g) => {
        const reasons: string[] = [];
        const c = clutchInfo(g);
        const st = stakes.get(g.id);
        const fav = favTeams.includes(`${g.league}:${g.home.abbr}`) || favTeams.includes(`${g.league}:${g.away.abbr}`);
        let watch = c.score;
        if (c.clutch) reasons.push(c.reason ?? 'Clutch');
        if (fav) { watch += 40; reasons.push('Your team'); }
        if (st) {
          watch += st.score * 12;
          if (st.mine.length) reasons.push(`${st.mine.length} of your starters`);
          if (st.theirs.length) reasons.push(`${st.theirs.length} opp starters`);
        }
        if (g.situation?.isRedZone) { watch += 10; reasons.push('Red zone'); }
        return { g, stakes: st, watch, reasons };
      })
      .sort((a, b) => b.watch - a.watch || a.g.start - b.g.start);
  }, [games, favTeams, matchup, players]);
  return ranked.filter((r) => filter(r.g));
}

import { useMemo } from 'react';
import { useApp } from '../store/app';
import { stakesByGame, useFantasy, type GameStakes } from '../store/fantasy';
import { clutchInfo } from '../lib/sports';
import { buildPlan, planCandidates } from '../lib/scheduler';
import { matchBroadcasts } from '../lib/channelMatch';
import { useBets } from '../store/bets';
import { useSchedulePrefs } from '../store/schedulePrefs';
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

/**
 * Smart Schedule for [from, to): candidates (my teams, fantasy starters, open bets, rules, pinned
 * items, big national games) → priorities → a plan with one primary pick per time slot and
 * Multiview suggestions. Every game candidate gets the channel matchBroadcasts finds for it.
 */
export function useSmartPlan(from: number, to: number) {
  const games = useApp((s) => s.games);
  const schedule = useApp((s) => s.schedule);
  const favTeams = useApp((s) => s.favTeams);
  const channels = useApp((s) => s.channels);
  const overrides = useApp((s) => s.networkOverrides);
  const matchup = useFantasy((s) => s.matchup);
  const players = useFantasy((s) => s.players);
  const bets = useBets((s) => s.bets);
  const pinned = useSchedulePrefs((s) => s.pinned);
  const skipped = useSchedulePrefs((s) => s.skipped);
  const includeOther = useSchedulePrefs((s) => s.includeOther);
  return useMemo(() => {
    const list = Object.values(games);
    const stakes = new Map<string, { mine: number; theirs: number }>();
    for (const [id, st] of stakesByGame(list, matchup, players)) stakes.set(id, { mine: st.mine.length, theirs: st.theirs.length });
    const betEvents = new Set<string>();
    for (const b of bets) if (b.status === 'open') for (const l of b.legs) if (l.eventId) betEvents.add(l.eventId);
    const cands = planCandidates({ from, to, games: list, schedule, favTeams, stakes, betEvents, pinned, skipped, includeOther, clutch: (g) => clutchInfo(g).score });
    for (const c of cands) {
      if (c.channelId || !c.eventId) continue;
      const g = games[c.eventId];
      const m = g ? matchBroadcasts(g.broadcasts, channels, overrides) : null;
      if (m) c.channelId = m.channel.id;
    }
    const slots = buildPlan(cands);
    return { cands, slots };
  }, [games, schedule, favTeams, channels, overrides, matchup, players, bets, pinned, skipped, includeOther, from, to]);
}

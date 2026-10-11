import { useMemo } from 'react';
import { nowPlaying, programsByChannel, useApp } from '../../store/app';
import { matchBroadcasts } from '../../lib/channelMatch';
import { SPORTS, sportOfLeague, sportOfProgram, sportsOfName, type SportKey } from '../../lib/sportsOf';
import type { OrgChannel, Organized } from '../../lib/channelOrg';
import { isIdleFeed } from '../../lib/gameChannels';

export interface SportBucket {
  /** Logical channel ids: airing this sport now first, then the sport's channels in lineup order. */
  ids: string[];
  /** Channels airing this sport right now (guide programme or a matched live game). */
  live: Set<string>;
  /** How many of `ids` are empty numbered feeds (":Milb 06", "ESPN+ 111:"); they sort last and aren't counted. */
  idle: number;
}

/**
 * Live TV channels by sport (see lib/sportsOf.ts). `now` should tick about once a minute: what's on
 * changes, the channel names don't.
 */
export function useSportRail(live: OrgChannel[], org: Organized, now: number): Map<SportKey, SportBucket> {
  const programs = useApp((s) => s.programs);
  const games = useApp((s) => s.games);
  const channels = useApp((s) => s.channels);
  const overrides = useApp((s) => s.networkOverrides);

  // By name: only channels the organizer put in Sports.
  const byName = useMemo(() => {
    const m = new Map<SportKey, string[]>();
    const idle = new Set<string>();
    for (const c of live) {
      if (c.category !== 'Sports') continue;
      const ks = sportsOfName(c.displayName, c.rawGroup, c.country);
      for (const k of ks.length ? ks : (['networks'] as SportKey[])) {
        let a = m.get(k);
        if (!a) m.set(k, (a = []));
        a.push(c.id);
      }
      if (isIdleFeed(c.rawName)) idle.add(c.id);
    }
    // Real channels and feeds named for an event first, empty feeds last.
    for (const [k, a] of m) m.set(k, [...a.filter((id) => !idle.has(id)), ...a.filter((id) => idle.has(id))]);
    return { m, idle };
  }, [live]);

  return useMemo(() => {
    const visible = new Set(live.map((c) => c.id));
    const nowOn = new Map<SportKey, Set<string>>();
    const add = (k: SportKey, rawId: string) => {
      const id = org.alias.get(rawId) ?? rawId;
      if (!visible.has(id)) return;
      let s = nowOn.get(k);
      if (!s) nowOn.set(k, (s = new Set()));
      s.add(id);
    };
    for (const g of Object.values(games)) {
      if (g.state !== 'in') continue;
      const m = matchBroadcasts(g.broadcasts, channels, overrides)?.channel.id;
      if (m) add(sportOfLeague(g.league), m);
    }
    for (const [chId] of programsByChannel(programs)) {
      const p = nowPlaying(programs, chId, now);
      if (!p || !(p.isSports || /sport/i.test(p.category))) continue;
      const k = sportOfProgram(p.title, p.category, org.byId.get(org.alias.get(chId) ?? chId)?.country);
      if (k) add(k, chId);
    }
    const out = new Map<SportKey, SportBucket>();
    for (const { key } of SPORTS) {
      const liveIds = nowOn.get(key) ?? new Set<string>();
      const ids = [...liveIds, ...(byName.m.get(key) ?? []).filter((id) => !liveIds.has(id))];
      out.set(key, { ids, live: liveIds, idle: ids.filter((id) => byName.idle.has(id) && !liveIds.has(id)).length });
    }
    return out;
  }, [byName, live, org, games, channels, overrides, programs, now]);
}

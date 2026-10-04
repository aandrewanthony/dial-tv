import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { Zap } from 'lucide-react';
import { useApp } from '../../store/app';
import { useRankedGames, type RankedGame } from '../../hooks/useSports';
import { matchBroadcasts } from '../../lib/channelMatch';
import type { Organized } from '../../lib/channelOrg';

/** RedZone mode (this session): Live TV follows the most watchable live game with a channel. */
export const useRedZone = create<{ on: boolean }>(() => ({ on: false }));

const MIN_STAY_MS = 75_000; // never flip faster than this
const BETTER_BY = 15; // a new game must beat the current one by this much (watchability points)

export function RedZoneButton() {
  const on = useRedZone((s) => s.on);
  return (
    <button className={`redZoneBtn ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => useRedZone.setState({ on: !on })}
      title="Follow the closest live game: switches channels on its own when another game gets better">
      <Zap /> {on ? 'RedZone on' : 'RedZone'}
    </button>
  );
}

/**
 * While on: every games update, pick the best live game whose broadcast is in the lineup and tune it
 * when it beats the game on screen by a clear margin (or the current game ended / isn't a game),
 * staying at least 75 s on a game. Uses the same watchability score as Game Day (close + late,
 * your teams, fantasy stakes, red zone).
 */
export function useRedZoneSwitch(currentId: string | undefined, org: Organized) {
  const on = useRedZone((s) => s.on);
  const channels = useApp((s) => s.channels);
  const overrides = useApp((s) => s.networkOverrides);
  const ranked = useRankedGames((g) => g.state === 'in');
  const lastSwitch = useRef(0);
  useEffect(() => {
    if (!on) return;
    const withCh = ranked
      .map((r) => {
        const raw = matchBroadcasts(r.g.broadcasts, channels, overrides)?.channel.id;
        const id = raw ? org.alias.get(raw) ?? raw : undefined;
        return id && org.byId.has(id) ? { r, id } : null;
      })
      .filter((x): x is { r: RankedGame; id: string } => !!x);
    const best = withCh[0];
    if (!best || best.id === currentId) return;
    const cur = withCh.find((x) => x.id === currentId);
    const now = Date.now();
    if (cur && now - lastSwitch.current < MIN_STAY_MS) return;
    if (cur && best.r.watch - cur.r.watch < BETTER_BY) return;
    lastSwitch.current = now;
    const app = useApp.getState();
    app.tune(best.id);
    const g = best.r.g;
    app.toast({ kind: 'redzone', title: `RedZone: ${g.away.abbr} @ ${g.home.abbr}`, body: [g.statusText, ...best.r.reasons].filter(Boolean).join(' · '), ttl: 5000 });
  }, [on, ranked, channels, overrides, org, currentId]);
}

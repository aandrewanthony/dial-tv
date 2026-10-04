import { useEffect, useId, useReducer, type CSSProperties } from 'react';
import type { SportEvent } from '../types';
import { winProbability } from '../providers/espn';
import { usableColor, wpLatest, wpPaths } from '../lib/winProb';

/** Live games refetch at most this often while their chart is open. */
export const WP_REFRESH_MS = 60_000;
/** A live game ESPN had no data for is retried after this long (the button hides until then). */
const MISSING_RETRY_MS = 5 * 60_000;

interface Entry { data: number[] | null; at: number; final: boolean }
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();

function load(g: SportEvent): Promise<void> {
  let p = inflight.get(g.id);
  if (!p) {
    const final = g.state === 'post';
    p = winProbability(g)
      .then((data) => { cache.set(g.id, { data, at: Date.now(), final }); })
      .finally(() => inflight.delete(g.id));
    inflight.set(g.id, p);
  }
  return p;
}

/** True when ESPN is known to have no win probability for this game (hide the toggle). */
export function wpUnavailable(g: SportEvent): boolean {
  const e = cache.get(g.id);
  if (!e || e.data) return false;
  return e.final || g.state === 'post' || Date.now() - e.at < MISSING_RETRY_MS;
}

/** Fetches lazily (only while `enabled`), caches per game, refreshes live games every minute. */
export function useWinProbability(g: SportEvent, enabled: boolean): { data: number[] | null; loading: boolean } {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const live = g.state === 'in';
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const run = () => { void load(g).then(() => alive && rerender()); };
    const e = cache.get(g.id);
    // Fetch if never loaded, or if the cached copy is from before the game ended / is stale.
    if (!e || (!e.final && (g.state === 'post' || Date.now() - e.at >= WP_REFRESH_MS))) run();
    const t = live ? setInterval(() => { if (document.visibilityState !== 'hidden') run(); }, WP_REFRESH_MS) : undefined;
    return () => { alive = false; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, g.id, g.state, live]);
  const e = cache.get(g.id);
  return { data: e?.data ?? null, loading: enabled && !e };
}

const W = 300;
const H = 64;

export function WinProbChart({ g, series }: { g: SportEvent; series: number[] }) {
  const id = useId().replace(/:/g, '');
  const latest = wpLatest(series);
  if (!latest) return null;
  const homeC = usableColor(g.home.color) ?? 'var(--accent)';
  let awayC = usableColor(g.away.color) ?? 'var(--good)';
  if (awayC.toLowerCase() === homeC.toLowerCase()) awayC = 'var(--muted)';
  const { line, area } = wpPaths(series, W, H);
  const leadTeam = latest.leader === 'home' ? g.home : g.away;
  const label = `Win probability: ${g.home.abbr} ${latest.home}%, ${g.away.abbr} ${100 - latest.home}%`;
  return (
    <div className="wpChart" style={{ '--wp-home': homeC, '--wp-away': awayC } as CSSProperties}>
      <div className="wpPlot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
          <defs>
            <clipPath id={`${id}t`}><rect x="0" y="0" width={W} height={H / 2} /></clipPath>
            <clipPath id={`${id}b`}><rect x="0" y={H / 2} width={W} height={H / 2} /></clipPath>
          </defs>
          <path d={area} className="wpFillHome" clipPath={`url(#${id}t)`} />
          <path d={area} className="wpFillAway" clipPath={`url(#${id}b)`} />
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="wpMid" vectorEffect="non-scaling-stroke" />
          <path d={line} className="wpLine" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="wpDot" style={{ top: `${100 - latest.home}%`, background: latest.leader === 'home' ? homeC : awayC }} />
        <span className="wpSide home">{g.home.abbr}</span>
        <span className="wpSide away">{g.away.abbr}</span>
      </div>
      <div className="wpNow">
        <b style={{ color: latest.leader === 'home' ? homeC : awayC }}>{latest.pct}%</b>
        <small>{leadTeam.abbr}{g.state === 'post' ? '' : ' to win'}</small>
      </div>
    </div>
  );
}

/** The opened panel inside a game card. */
export function WinProbPanel({ g }: { g: SportEvent }) {
  const { data, loading } = useWinProbability(g, true);
  return (
    <div className="wpPanel">
      <div className="wpHead"><span>Win probability</span>{g.state === 'in' && <em>updates every minute</em>}</div>
      {data && data.length ? <WinProbChart g={g} series={data} />
        : <div className="wpEmpty">{loading ? 'Loading…' : 'ESPN has no win probability for this game.'}</div>}
    </div>
  );
}

/**
 * Penalty alerts: while you watch a live NFL / college football / NHL game, read ESPN's live
 * play-by-play (one small request every 20 s, only for the game on screen) and show what the flag
 * was: "Offensive Holding · MIA #P.Paul · 10 yards". Nothing runs for other channels.
 */
import { useEffect, useRef } from 'react';
import { useApp } from '../store/app';
import type { League, SportEvent } from '../types';

export interface Penalty {
  id: string;
  what: string;
  team?: string;
  player?: string;
  result?: string;
  clock?: string;
  period?: number;
}

const PATHS: Partial<Record<League, string>> = { nfl: 'football/nfl', ncaaf: 'football/college-football', nhl: 'hockey/nhl' };
export const penaltyLeague = (l: League) => l in PATHS;

/** Football: "PENALTY on MIA-P.Paul, Offensive Holding, 10 yards, enforced at…". Hockey: "X Hooking penalty …". */
export function parsePenalty(text: string, league: League): Omit<Penalty, 'id'> | null {
  if (league === 'nhl') {
    const m = /^(.+?)\s+(\w[\w -]*?)\s*(?:\((\d+) min\)|penalty)/i.exec(text.trim());
    return m ? { what: m[2].trim(), player: m[1].trim(), result: m[3] ? `${m[3]} min` : undefined } : null;
  }
  const m = /PENALTY on ([A-Z]{2,4})-([^,]+?),\s*([^,]+?),\s*(\d+ yards?|declined|offsetting|[^,.]+)/i.exec(text);
  if (!m) return null;
  return { team: m[1], player: m[2].trim(), what: m[3].trim(), result: m[4].trim() };
}

async function fetchPenalties(ev: SportEvent, signal: AbortSignal): Promise<Penalty[]> {
  const [league, id] = ev.id.split(':') as [League, string];
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${PATHS[league]}/summary?event=${id}`, { signal });
  if (!res.ok) return [];
  const j = await res.json();
  type Play = { id: string; text?: string; type?: { text?: string }; period?: { number?: number }; clock?: { displayValue?: string } };
  const plays: Play[] = league === 'nhl'
    ? (j?.plays ?? []).filter((p: Play) => /penalty/i.test(p.type?.text ?? ''))
    : [...(j?.drives?.previous ?? []).flatMap((d: { plays?: Play[] }) => d.plays ?? []), ...(j?.drives?.current?.plays ?? [])].filter((p: Play) => /penalty on/i.test(p.text ?? ''));
  const out: Penalty[] = [];
  for (const p of plays) {
    const parsed = parsePenalty(p.text ?? '', league);
    if (parsed) out.push({ id: String(p.id), ...parsed, period: p.period?.number, clock: p.clock?.displayValue });
  }
  return out;
}

/** Polls the game on screen and toasts each new flag (the flags already thrown when you tune in are skipped). */
export function usePenaltyAlerts(game: SportEvent | undefined) {
  const on = useApp((s) => s.settings.penaltyAlerts !== false);
  const seen = useRef(new Set<string>());
  const league = game?.id.split(':')[0] as League | undefined;
  const active = on && !!game && game.state === 'in' && !!league && penaltyLeague(league);
  const gameId = active ? game!.id : undefined;
  useEffect(() => {
    if (!gameId) return;
    const ctl = new AbortController();
    let first = true;
    seen.current = new Set();
    const tick = async () => {
      if (document.hidden) return;
      try {
        const list = await fetchPenalties({ ...game!, id: gameId }, ctl.signal);
        for (const p of list) {
          if (seen.current.has(p.id)) continue;
          seen.current.add(p.id);
          if (first) continue;
          useApp.getState().toast({
            kind: 'info',
            title: `🚩 ${p.what}`,
            body: [p.team && p.player ? `${p.team} · ${p.player}` : p.player, p.result].filter(Boolean).join(' · '),
            ttl: 9000,
          });
        }
        first = false;
      } catch { /* offline or aborted: try again next tick */ }
    };
    void tick();
    const t = setInterval(tick, 20_000);
    return () => { ctl.abort(); clearInterval(t); };
  }, [gameId]); // eslint-disable-line react-hooks/exhaustive-deps
}

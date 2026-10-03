import type { Program, ScheduleEntry, ScheduleRule, SportEvent } from '../types';

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }) {
  return a.start < b.end && b.start < a.end;
}

/** Map of entry id → ids of entries it collides with. */
export function findConflicts(entries: ScheduleEntry[]): Map<string, string[]> {
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  const out = new Map<string, string[]>();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
      if (overlaps(sorted[i], sorted[j])) {
        out.set(sorted[i].id, [...(out.get(sorted[i].id) ?? []), sorted[j].id]);
        out.set(sorted[j].id, [...(out.get(sorted[j].id) ?? []), sorted[i].id]);
      }
    }
  }
  return out;
}

/**
 * Lay out overlapping entries into side-by-side lanes (like a calendar day view).
 * Returns lane index and total lanes in that entry's overlap cluster.
 */
export function layoutLanes(entries: ScheduleEntry[]): Map<string, { lane: number; lanes: number }> {
  const sorted = [...entries].sort((a, b) => a.start - b.start || b.end - a.end);
  const result = new Map<string, { lane: number; lanes: number }>();
  let cluster: ScheduleEntry[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const e of cluster) result.get(e.id)!.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const e of sorted) {
    if (e.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= e.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(e.end);
    } else laneEnds[lane] = e.end;
    result.set(e.id, { lane, lanes: 1 });
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  flush();
  return result;
}

export function snap(ms: number, stepMin = 15) {
  const step = stepMin * MIN;
  return Math.round(ms / step) * step;
}

/** Typical broadcast window by league, used when a game is added to the schedule. */
export const GAME_LENGTH: Record<string, number> = {
  nfl: 3.25 * HOUR, ncaaf: 3.5 * HOUR, nba: 2.5 * HOUR, wnba: 2 * HOUR, ncaam: 2.25 * HOUR,
  mlb: 3 * HOUR, nhl: 2.75 * HOUR, mls: 2 * HOUR, epl: 2 * HOUR,
};

export function entryFromGame(g: SportEvent, ruleId?: string, reminderMin?: number): ScheduleEntry {
  return {
    id: `game:${g.id}`,
    title: `${g.away.abbr} @ ${g.home.abbr}`,
    start: g.start,
    end: g.start + (GAME_LENGTH[g.league] ?? 3 * HOUR),
    eventId: g.id,
    notes: `${g.league.toUpperCase()} · ${g.away.name} at ${g.home.name}${g.broadcasts.length ? ' · ' + g.broadcasts.join(', ') : ''}`,
    ruleId,
    reminderMin,
  };
}

export function entryFromProgram(p: Program, ruleId?: string, reminderMin?: number): ScheduleEntry {
  return {
    id: `prog:${p.id}`,
    title: p.title,
    start: p.start,
    end: p.end,
    channelId: p.channelId,
    programId: p.id,
    notes: p.subtitle,
    ruleId,
    reminderMin,
  };
}

/** Local-time midnight for a given epoch ms. */
export function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Expand rules into concrete schedule entries for the window [from, to).
 * Existing entries with the same id are not duplicated by the caller (ids are deterministic).
 */
export function applyRules(
  rules: ScheduleRule[],
  ctx: { games: SportEvent[]; programs: Program[]; from: number; to: number },
): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  const ids = new Set<string>();
  /** title rules: one entry per (title, start) even when several channels air it. */
  const titleSlots = new Set<string>();
  const push = (e: ScheduleEntry) => {
    if (ids.has(e.id)) return;
    ids.add(e.id);
    out.push(e);
  };
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.kind === 'team') {
      const [league, abbr] = r.match.split(':');
      for (const g of ctx.games) {
        if (g.league !== league || g.start < ctx.from || g.start >= ctx.to || g.state === 'post') continue;
        if (g.home.abbr === abbr || g.away.abbr === abbr) push(entryFromGame(g, r.id, r.reminderMin));
      }
    } else if (r.kind === 'title') {
      const needle = r.match.toLowerCase();
      if (!needle) continue;
      for (const p of ctx.programs) {
        if (p.start < ctx.from || p.start >= ctx.to) continue;
        if (!p.title.toLowerCase().includes(needle)) continue;
        const slot = `${p.title.toLowerCase()}|${p.start}`;
        if (titleSlots.has(slot)) continue;
        titleSlots.add(slot);
        push(entryFromProgram(p, r.id, r.reminderMin));
      }
    } else if (r.kind === 'block' && r.startMin != null && r.endMin != null) {
      for (let day = startOfDay(ctx.from); day < ctx.to; day += 24 * HOUR) {
        // Re-normalize to local midnight to survive DST shifts.
        const d0 = startOfDay(day + 2 * HOUR);
        const dow = new Date(d0).getDay();
        if (r.days && !r.days.includes(dow)) continue;
        const start = d0 + r.startMin * MIN;
        const end = d0 + (r.endMin > r.startMin ? r.endMin : r.endMin + 24 * 60) * MIN;
        if (end <= ctx.from || start >= ctx.to) continue;
        push({ id: `rule:${r.id}:${d0}`, title: r.match || 'Reserved', start, end, ruleId: r.id, reminderMin: r.reminderMin, color: 'reserved' });
      }
    }
  }
  return out;
}

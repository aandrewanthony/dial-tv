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

// ---------- Smart Schedule: candidates → priority → plan ----------

export type PlanTier = 'pinned' | 'team' | 'fantasy' | 'bet' | 'rule' | 'national' | 'other';

export interface PlanCandidate {
  /** Stable id: `game:<eventId>` or the schedule entry id. */
  id: string;
  title: string;
  start: number;
  end: number;
  eventId?: string;
  programId?: string;
  channelId?: string;
  league?: string;
  tier: PlanTier;
  priority: number;
  reasons: string[];
}

export interface PlanInput {
  from: number;
  to: number;
  games: SportEvent[];
  schedule: ScheduleEntry[];
  favTeams: string[];
  /** eventId → number of my / opponent's fantasy starters in the game. */
  stakes?: Map<string, { mine: number; theirs: number }>;
  /** Games with an open bet. */
  betEvents?: Set<string>;
  /** Candidate ids the user pinned (always on top) or skipped (never planned). */
  pinned?: string[];
  skipped?: string[];
  /** Also consider games with no personal stake (national TV / close line / clutch now). Default true. */
  includeOther?: boolean;
  /** At most this many no-stake "big games" (best first). Default 6. */
  maxOther?: number;
  /** 0–100 "clutch right now" score for live games (lib/sports clutchInfo). */
  clutch?: (g: SportEvent) => number;
}

/** Networks that carry a game nationally (a rough "big game" signal). */
const NATIONAL = /^(espn|espn2|abc|nbc|cbs|fox|fs1|tnt|tbs|trutv|prime video|amazon prime video|peacock|netflix|nfl network|nfl net|nba tv|nhl network|mlb network|apple tv|youtube)$/i;

export const TIER_BASE: Record<PlanTier, number> = { pinned: 200, team: 100, fantasy: 60, rule: 50, bet: 45, national: 30, other: 10 };

/**
 * Collect everything worth watching in [from, to) and score it:
 * pinned > my team > fantasy stakes > show rules / open bets > national TV / close line / clutch > other.
 * A candidate's priority is the sum of every reason it has; its tier is its strongest reason.
 */
export function planCandidates(input: PlanInput): PlanCandidate[] {
  const out = new Map<string, PlanCandidate>();
  const skipped = new Set(input.skipped ?? []);
  const fav = new Set(input.favTeams);
  const inWindow = (s: number, e: number) => e > input.from && s < input.to;

  const add = (c: PlanCandidate, tier: PlanTier, bonus: number, reason: string) => {
    const cur = out.get(c.id) ?? c;
    const fresh = !out.has(c.id);
    cur.priority += TIER_BASE[tier] + bonus;
    if (fresh || TIER_BASE[tier] > TIER_BASE[cur.tier]) cur.tier = tier;
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    out.set(c.id, cur);
  };

  for (const g of input.games) {
    if (g.state === 'post' || g.postponed || g.canceled) continue;
    const base = entryFromGame(g);
    if (!inWindow(base.start, base.end) || skipped.has(base.id)) continue;
    const cand = (): PlanCandidate => ({ id: base.id, title: base.title, start: base.start, end: base.end, eventId: g.id, league: g.league, tier: 'other', priority: 0, reasons: [] });
    if (fav.has(`${g.league}:${g.home.abbr}`) || fav.has(`${g.league}:${g.away.abbr}`)) add(cand(), 'team', 0, 'Your team');
    const st = input.stakes?.get(g.id);
    if (st && st.mine + st.theirs > 0) add(cand(), 'fantasy', st.mine * 6 + st.theirs * 3, `Fantasy: ${st.mine} yours, ${st.theirs} opp`);
    if (input.betEvents?.has(g.id)) add(cand(), 'bet', 0, 'Open bet');
    const national = g.broadcasts.some((b) => NATIONAL.test(b.trim()));
    const close = g.odds?.spread != null && Math.abs(g.odds.spread) <= 3;
    const clutch = g.state === 'in' && input.clutch ? input.clutch(g) : 0;
    if (out.has(base.id)) {
      // Tie-breakers among personal games.
      out.get(base.id)!.priority += (national ? 8 : 0) + (close ? 5 : 0) + Math.round(clutch / 5);
    } else if (input.includeOther !== false) {
      const primetime = new Date(g.start).getHours() >= 19;
      // Only genuinely big games: clutch right now, or national TV in prime time / with a close line.
      if (!(clutch >= 60 || (national && (primetime || close)))) continue;
      const why = clutch >= 60 ? 'Clutch now' : national ? `National TV${primetime ? ' · prime time' : ''}` : 'Close line';
      add(cand(), 'national', (primetime ? 10 : 0) + (close ? 10 : 0) + Math.round(clutch / 3), why);
    }
  }

  // The user's own schedule: hand-added items are pinned; rule-made shows count as rule matches.
  for (const e of input.schedule) {
    if (!inWindow(e.start, e.end) || e.color === 'reserved') continue;
    const id = e.eventId ? `game:${e.eventId}` : e.id;
    if (skipped.has(id)) continue;
    const existing = out.get(id);
    if (e.eventId && existing) {
      if (e.channelId) existing.channelId = e.channelId;
      if (!e.ruleId) add(existing, 'pinned', 0, 'On your schedule');
    } else if (e.eventId) {
      // A scheduled game with no live data (e.g. outside the scores window): keep its scheduled time.
      add({ id, title: e.title, start: e.start, end: e.end, eventId: e.eventId, channelId: e.channelId, tier: 'other', priority: 0, reasons: [] }, e.ruleId ? 'team' : 'pinned', 0, e.ruleId ? 'Team rule' : 'On your schedule');
    } else {
      add({ id, title: e.title, start: e.start, end: e.end, programId: e.programId, channelId: e.channelId, tier: 'other', priority: 0, reasons: [] }, e.ruleId ? 'rule' : 'pinned', 0, e.ruleId ? 'Show rule' : 'On your schedule');
    }
  }
  // Keep only the best few no-stake games so a busy Saturday doesn't drown the personal picks.
  const others = [...out.values()].filter((c) => c.tier === 'national').sort((a, b) => b.priority - a.priority);
  for (const c of others.slice(input.maxOther ?? 6)) out.delete(c.id);
  for (const id of input.pinned ?? []) {
    const c = out.get(id);
    if (c && !c.reasons.includes('Pinned')) add(c, 'pinned', 0, 'Pinned');
  }
  return [...out.values()].sort((a, b) => b.priority - a.priority || a.start - b.start);
}

export interface PlanSlot {
  start: number;
  end: number;
  /** What to watch on the main screen. */
  primary: PlanCandidate;
  /** Also on at the same time, best first: Multiview suggestions. */
  also: PlanCandidate[];
  conflict: boolean;
}

/**
 * Turn candidates into a plan: split time at every start/end, pick the highest-priority item on air
 * in each piece (sticky: the current pick stays until something strictly better starts), and merge
 * neighbouring pieces with the same pick. Everything else on air goes to "also in Multiview".
 */
export function buildPlan(cands: PlanCandidate[], maxAlso = 3): PlanSlot[] {
  const pts = [...new Set(cands.flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
  const slots: PlanSlot[] = [];
  let prev: PlanCandidate | undefined;
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    const active = cands.filter((c) => c.start < e && c.end > s).sort((a, b) => b.priority - a.priority || a.start - b.start);
    if (!active.length) {
      prev = undefined;
      continue;
    }
    let primary = active[0];
    if (prev && active.includes(prev) && prev.priority >= primary.priority) primary = prev;
    const also = active.filter((c) => c !== primary).slice(0, maxAlso);
    const last = slots[slots.length - 1];
    if (last && last.end === s && last.primary === primary) {
      // Same pick continues: one slot, with everything that overlapped it at some point.
      last.end = e;
      const merged = [...last.also, ...also.filter((c) => !last.also.includes(c))].sort((a, b) => b.priority - a.priority || a.start - b.start);
      last.also = merged.slice(0, maxAlso);
      last.conflict = last.conflict || active.length > 1;
    } else slots.push({ start: s, end: e, primary, also, conflict: active.length > 1 });
    prev = primary;
  }
  return slots;
}

/** Schedule entries for accepting a plan: one per distinct primary pick (games keep their `game:` id). */
export function planEntries(
  slots: PlanSlot[],
  games: Record<string, SportEvent>,
  channelFor: (c: PlanCandidate) => string | undefined,
  reminderMin?: number,
): ScheduleEntry[] {
  const out = new Map<string, ScheduleEntry>();
  for (const s of slots) {
    const c = s.primary;
    if (out.has(c.id)) continue;
    const g = c.eventId ? games[c.eventId] : undefined;
    const base: ScheduleEntry = g ? entryFromGame(g) : { id: c.id, title: c.title, start: c.start, end: c.end, programId: c.programId, eventId: c.eventId };
    out.set(c.id, {
      ...base,
      channelId: c.channelId ?? channelFor(c),
      reminderMin: reminderMin ?? base.reminderMin,
      notes: [base.notes, `Smart Schedule: ${c.reasons.join(', ')}`].filter(Boolean).join(' · '),
    });
  }
  return [...out.values()];
}

/**
 * Auto-tune: the accepted-plan entry that just started and should take over the screen.
 * Each entry fires once (`fired` holds `${id}:${start}`), only within `windowMs` of its start, never when
 * already on that channel, and not while the viewer watches another of their teams with "don't interrupt" on.
 */
export function autoTuneTarget(
  now: number,
  entries: { id: string; start: number; channelId?: string }[],
  ctx: { currentId?: string; fired: Set<string>; watchingMyTeam: boolean; dontInterrupt: boolean; windowMs?: number },
): { id: string; key: string; channelId: string } | undefined {
  const win = ctx.windowMs ?? 2 * MIN;
  const due = entries
    .filter((e) => e.channelId && e.start <= now && now - e.start < win && !ctx.fired.has(`${e.id}:${e.start}`))
    .sort((a, b) => b.start - a.start)[0];
  if (!due || due.channelId === ctx.currentId) return undefined;
  if (ctx.watchingMyTeam && ctx.dontInterrupt) return undefined;
  return { id: due.id, key: `${due.id}:${due.start}`, channelId: due.channelId! };
}

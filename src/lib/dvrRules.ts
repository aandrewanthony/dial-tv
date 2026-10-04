/**
 * DVR recording rules (desktop): "auto-record my teams" and series recordings. Rules live in the
 * renderer (a persisted store); the shell (electron/dvr.cjs) only ever sees the concrete recordings
 * they produce, each tagged with `rule` ({ id, label, key }) so the UI can show "Auto: Lions".
 *
 * - Team rule: every upcoming game (ESPN scoreboards already polled, ~7 days ahead) of a favourite
 *   team whose broadcast matches a playlist channel (matchBroadcasts, with networkOverrides) is
 *   recorded from kickoff − padBefore to a sport-typical length + padAfter. While the game is live
 *   and near the end, the recording is pushed later (dvr:extend, max +90 min).
 * - Series rule: guide programmes with the same title (case-insensitive), on one channel or any,
 *   optionally new episodes only, are recorded whenever the guide (re)loads.
 *
 * Re-evaluated when games, channels, overrides, favourite teams, the guide or the rules change.
 * Nothing is scheduled twice: a game / airing that already has a recording (in any state, so a
 * cancelled one stays cancelled) is skipped. Overlaps beyond "at once" are scheduled anyway (the
 * shell queues them) with a warning.
 */
import { createPersisted } from '../store/persisted';
import { programsByChannel, useApp } from '../store/app';
import { isPersonalId } from '../store/tv';
import { matchBroadcasts } from './channelMatch';
import { leagueLabel } from './sports';
import { dvrBridge, jobBase, useDvr, type DvrJob, type DvrSettings, type Recording } from './dvr';
import type { Channel, League, Program, SportEvent } from '../types';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const LOOKAHEAD = 7 * DAY;
/** Most upcoming recordings one series rule schedules at a time. */
const MAX_PER_SERIES = 30;

/** Typical broadcast length per league, in minutes (before padding). */
export const GAME_MINUTES: Record<League, number> = {
  nfl: 210, ncaaf: 225, nba: 165, wnba: 150, ncaam: 150, mlb: 195, nhl: 165, mls: 135, epl: 135,
};

export interface SeriesRule {
  id: string;
  title: string;
  /** Only this channel (unset = any channel). */
  channelId?: string;
  channelName?: string;
  newOnly: boolean;
  enabled: boolean;
  createdAt: number;
}

interface RulesState {
  /** Auto-record my teams (off by default). */
  teamsOn: boolean;
  /** Favourite teams (`league:ABBR`) switched off for auto-recording. */
  teamsOff: string[];
  series: SeriesRule[];
}

export const useRecRules = createPersisted<RulesState>({
  key: 'dvrRules',
  version: 1,
  defaults: () => ({ teamsOn: false, teamsOff: [], series: [] }),
});

export const teamRuleId = (team: string) => `team:${team}`;

/** Display name for a favourite team key, from any game we have for it ("Lions"), else "NFL DET". */
export function teamName(key: string, games: Record<string, SportEvent>): string {
  const [league, abbr] = key.split(':');
  for (const g of Object.values(games)) {
    if (g.league !== league) continue;
    const t = g.home.abbr === abbr ? g.home : g.away.abbr === abbr ? g.away : undefined;
    if (t) return t.shortName || t.name || abbr;
  }
  return `${leagueLabel(league as League)} ${abbr}`;
}

const recordable = (c?: Channel): c is Channel => !!c && !isPersonalId(c.id) && (!c.kind || c.kind === 'live');

const findChannel = (channels: Channel[]) => {
  const byId = new Map(channels.map((c) => [c.id, c]));
  return (id: string) => byId.get(id);
};

export interface Plan {
  add: DvrJob[];
  /** Scheduled (not started) recordings to cancel and drop: rule turned off, game moved, channel changed. */
  drop: Recording[];
  /** Recordings to push later: [id, new end]. */
  extend: [string, number][];
}

interface TeamInput {
  now: number;
  games: Record<string, SportEvent>;
  favTeams: string[];
  teamsOn: boolean;
  teamsOff: string[];
  channels: Channel[];
  overrides: Record<string, string>;
  settings: Pick<DvrSettings, 'padBefore' | 'padAfter'>;
  recordings: Recording[];
}

/** Auto-record my teams. Pure: returns what to schedule / drop / extend. */
export function planTeams(i: TeamInput): Plan {
  const plan: Plan = { add: [], drop: [], extend: [] };
  const active = new Set(i.teamsOn ? i.favTeams.filter((t) => !i.teamsOff.includes(t)) : []);
  const channel = findChannel(i.channels);
  const byKey = new Map<string, Recording[]>();
  for (const r of i.recordings) {
    if (!r.rule?.id.startsWith('team:')) continue;
    // Rule switched off: drop what it scheduled (a recording already running keeps going).
    if (!active.has(r.rule.id.slice(5))) {
      if (r.status === 'scheduled') plan.drop.push(r);
      continue;
    }
    const list = byKey.get(r.rule.key);
    if (list) list.push(r);
    else byKey.set(r.rule.key, [r]);
  }
  if (!active.size) return plan;
  for (const g of Object.values(i.games)) {
    const mine = [g.home, g.away].map((t) => `${g.league}:${t.abbr}`).find((k) => active.has(k));
    if (!mine) continue;
    const key = `game:${g.id}`;
    const have = byKey.get(key) ?? [];
    const len = (GAME_MINUTES[g.league] ?? 180) * MIN;
    // Running long: keep the recording going while the game is live.
    for (const r of have) {
      if (r.status === 'recording' && g.state === 'in' && r.end - i.now < 15 * MIN) plan.extend.push([r.id, i.now + 20 * MIN]);
    }
    if (g.state === 'post' || g.start > i.now + LOOKAHEAD) continue;
    const scheduled = have.filter((r) => r.status === 'scheduled');
    if (g.postponed) { plan.drop.push(...scheduled); continue; }
    const start = g.start - i.settings.padBefore * MIN;
    const end = g.start + len + i.settings.padAfter * MIN;
    if (end <= i.now) continue;
    const m = matchBroadcasts(g.broadcasts, i.channels, i.overrides);
    const ch = m ? channel(m.channel.id) : undefined;
    if (!recordable(ch)) continue; // no channel (yet): keep whatever was set
    // Already handled (any state but a stale schedule): leave it. A cancelled one stays cancelled.
    const stale = scheduled.filter((r) => g.state === 'pre' && (r.channelId !== ch.id || r.start !== start));
    if (have.some((r) => !stale.includes(r))) continue;
    plan.drop.push(...stale);
    const label = teamName(mine, i.games);
    plan.add.push({
      ...jobBase(ch),
      title: `${g.away.shortName || g.away.abbr} @ ${g.home.shortName || g.home.abbr}`,
      subtitle: leagueLabel(g.league),
      start, end,
      rule: { id: teamRuleId(mine), label, key },
    });
  }
  return plan;
}

interface SeriesInput {
  now: number;
  rules: SeriesRule[];
  programs: Program[];
  channels: Channel[];
  settings: Pick<DvrSettings, 'padBefore' | 'padAfter'>;
  recordings: Recording[];
}

/** Has this airing been recorded / scheduled already (by a rule or by hand, in any state)? */
function alreadyHas(recs: Recording[], p: Program, channelId: string, key: string) {
  const t = p.title.toLowerCase();
  return recs.some((r) => r.rule?.key === key
    || (r.programId === p.id && r.channelId === channelId)
    || (r.title.toLowerCase() === t && r.start <= p.start && r.end > p.start));
}

/** Series recordings. Pure: returns what to schedule / drop. */
export function planSeries(i: SeriesInput): Plan {
  const plan: Plan = { add: [], drop: [], extend: [] };
  const live = new Map(i.rules.filter((r) => r.enabled).map((r) => [r.id, r]));
  for (const r of i.recordings) {
    if (r.rule?.id.startsWith('series:') && r.status === 'scheduled' && !live.has(r.rule.id)) plan.drop.push(r);
  }
  if (!live.size) return plan;
  const channel = findChannel(i.channels);
  const index = programsByChannel(i.programs);
  const taken = new Set<string>();
  for (const rule of live.values()) {
    const t = rule.title.toLowerCase();
    const pool = rule.channelId ? index.get(rule.channelId) ?? [] : i.programs;
    const hits = pool.filter((p) => p.end > i.now && p.title.toLowerCase() === t && (!rule.newOnly || p.isNew)).sort((a, b) => a.start - b.start);
    let n = 0;
    for (const p of hits) {
      if (n >= MAX_PER_SERIES) break;
      const ch = channel(rule.channelId ?? p.channelId);
      if (!recordable(ch)) continue;
      const key = `prog:${t}|${p.start}`;
      if (taken.has(key) || alreadyHas(i.recordings, p, ch.id, key)) continue;
      taken.add(key);
      n++;
      plan.add.push({
        ...jobBase(ch),
        title: p.title, subtitle: p.subtitle, programId: p.id,
        start: p.start - i.settings.padBefore * MIN, end: p.end + i.settings.padAfter * MIN,
        rule: { id: rule.id, label: rule.title, key },
      });
    }
  }
  return plan;
}

// ---------------------------------------------------------------- runner

/** Keys scheduled in the last minute (the shell's change event can trail the reply). */
const recent = new Map<string, number>();
let running: Promise<Record<string, number>> | null = null;
let again = false;

/** Apply the rules now. Returns how many recordings each rule added. Desktop only. */
export function runRecRules(): Promise<Record<string, number>> {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      let out: Record<string, number> = {};
      do {
        again = false;
        out = await applyOnce();
      } while (again);
      return out;
    } finally {
      running = null;
    }
  })();
  return running;
}

async function applyOnce(): Promise<Record<string, number>> {
  const b = dvrBridge();
  const dvr = useDvr.getState();
  const rules = useRecRules.getState();
  const app = useApp.getState();
  const added: Record<string, number> = {};
  if (!b || !dvr.ready || !dvr.available || !rules.hydrated || !app.hydrated || !app.channels.length) return added;
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > MIN) recent.delete(k);
  const base = { now, channels: app.channels, settings: dvr.settings, recordings: dvr.recordings };
  const plans = [
    planTeams({ ...base, games: app.games, favTeams: app.favTeams, teamsOn: rules.teamsOn, teamsOff: rules.teamsOff, overrides: app.networkOverrides }),
    planSeries({ ...base, rules: rules.series, programs: app.programs }),
  ];
  let conflicts = 0;
  for (const plan of plans) {
    for (const r of plan.drop) {
      if (await b.stop(r.id)) await b.remove(r.id);
      if (r.rule) recent.delete(r.rule.key);
    }
    for (const [id, end] of plan.extend) await b.extend(id, end);
    for (const job of plan.add) {
      const key = job.rule!.key;
      if (recent.has(key)) continue;
      recent.set(key, now);
      let res: { error?: string; conflicts?: boolean };
      try { res = await b.schedule(job); } catch { continue; }
      if (res.error) continue; // e.g. already recording this channel by hand
      added[job.rule!.id] = (added[job.rule!.id] ?? 0) + 1;
      if (res.conflicts) conflicts++;
    }
  }
  if (conflicts) {
    const max = dvr.settings.maxConcurrent;
    app.toast({
      kind: 'error',
      title: `Auto-recording: more than ${max} overlap`,
      body: `${conflicts === 1 ? 'One recording waits' : `${conflicts} recordings wait`} for a free slot. See the Recordings page.`,
      ttl: 6000,
    });
  }
  return added;
}

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const soon = (ms = 1500) => { clearTimeout(timer); timer = setTimeout(() => void runRecRules(), ms); };

/** Start watching for changes that affect the rules (once; no-op on the web). */
export function initRecRules() {
  if (started || !dvrBridge()) return;
  started = true;
  useApp.subscribe((s, p) => {
    if (s.games !== p.games || s.channels !== p.channels || s.networkOverrides !== p.networkOverrides || s.favTeams !== p.favTeams || s.programs !== p.programs || s.hydrated !== p.hydrated) soon();
  });
  useRecRules.subscribe(() => soon(300));
  useDvr.subscribe((s, p) => {
    if ((s.ready && !p.ready) || s.settings.padBefore !== p.settings.padBefore) soon();
  });
  setInterval(() => void runRecRules(), 5 * MIN);
  soon(3000);
}

// ---------------------------------------------------------------- actions

export function setTeamsOn(on: boolean) {
  useRecRules.setState({ teamsOn: on });
}

export function setTeamOn(team: string, on: boolean) {
  useRecRules.setState((s) => ({ teamsOff: on ? s.teamsOff.filter((t) => t !== team) : [...new Set([...s.teamsOff, team])] }));
}

/** The series rule covering this programme (same title; this channel, or any channel), if any. */
export function seriesRuleFor(rules: SeriesRule[], title: string, channelId?: string) {
  const t = title.toLowerCase();
  return rules.find((r) => r.title.toLowerCase() === t && (!r.channelId || r.channelId === channelId));
}

export async function addSeriesRule(p: Program, ch: Channel | undefined, opts: { thisChannel: boolean; newOnly: boolean }) {
  const rule: SeriesRule = {
    id: `series:${Date.now().toString(36)}`,
    title: p.title,
    channelId: opts.thisChannel ? ch?.id : undefined,
    channelName: opts.thisChannel ? ((ch as { displayName?: string } | undefined)?.displayName ?? ch?.name) : undefined,
    newOnly: opts.newOnly,
    enabled: true,
    createdAt: Date.now(),
  };
  useRecRules.setState((s) => ({ series: [...s.series.filter((r) => !(r.title.toLowerCase() === rule.title.toLowerCase() && r.channelId === rule.channelId)), rule] }));
  const added = await runRecRules();
  const n = added[rule.id] ?? 0;
  useApp.getState().toast({
    kind: 'info',
    title: `Recording every “${rule.title}”`,
    body: n ? `${n} upcoming ${n === 1 ? 'airing' : 'airings'} set to record.` : 'Nothing in the guide yet; new airings record as the guide updates.',
    ttl: 4000,
  });
}

export function setSeriesEnabled(id: string, enabled: boolean) {
  useRecRules.setState((s) => ({ series: s.series.map((r) => (r.id === id ? { ...r, enabled } : r)) }));
}

export function removeSeriesRule(id: string) {
  useRecRules.setState((s) => ({ series: s.series.filter((r) => r.id !== id) }));
}

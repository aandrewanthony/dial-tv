import { useEffect, useRef } from 'react';
import { useApp } from '../store/app';
import { useFantasy } from '../store/fantasy';
import { nyDate, scoreboardFor, shiftYmd, ymd } from '../providers/espn';
import type { League, ScheduleEntry, SportEvent } from '../types';
import { clutchInfo, gradePick, leagueLabel } from '../lib/sports';
import { matchBroadcasts } from '../lib/channelMatch';
import { applyRules, HOUR, MIN, startOfDay } from '../lib/scheduler';
import { notify } from '../lib/notify';

const DAYS_BACK = 1;
const DAYS_AHEAD = 6;

/** Poll bookkeeping per scoreboard key `${league}|${YYYYMMDD}`. */
interface KeyState {
  /** Last successful fetch (completion time). */
  okAt: number;
  /** Last attempt (start time), successful or not. */
  attemptAt: number;
  /** Consecutive failures, for exponential backoff. */
  failures: number;
  inFlight: boolean;
}
const keyState = new Map<string, KeyState>();
/** game id → key it was last read from and when that fetch *started* (older responses never win). */
const gameSource = new Map<string, { key: string; startedAt: number }>();

/** Test hook. */
export function resetPollState() {
  keyState.clear();
  gameSource.clear();
}

const ks = (key: string) => {
  let s = keyState.get(key);
  if (!s) keyState.set(key, (s = { okAt: 0, attemptAt: 0, failures: 0, inFlight: false }));
  return s;
};

/** Delay before retrying a key after `failures` consecutive failures: 15s, 30s, 1m … capped at 30 min. */
export function backoffMs(failures: number) {
  return failures <= 0 ? 0 : Math.min(30 * MIN, 15_000 * 2 ** (failures - 1));
}

const isLiveOrSoon = (g: SportEvent, now: number) =>
  g.state === 'in' || (g.state === 'pre' && g.start - now < 15 * MIN && g.start > now - HOUR);

function dayStarts(now: number) {
  const today = startOfDay(now);
  const out: number[] = [];
  for (let d = -DAYS_BACK; d <= DAYS_AHEAD; d++) out.push(startOfDay(today + d * 24 * HOUR + 2 * HOUR));
  return out;
}

/** ESPN dates to query for an open pick whose game left the live window: its US-Eastern slate date and both neighbours. */
export function pickDates(start: number): string[] {
  const d = nyDate(start);
  return [d, shiftYmd(d, -1), shiftYmd(d, 1)];
}

interface Job {
  league: League;
  dates: string;
  key: string;
}

/**
 * Decide which scoreboards to fetch now. Any day that holds a live (or about-to-start) game
 * polls every 30s — including yesterday's slate for games running past local midnight.
 */
export function planJobs(
  now: number,
  state: { leagues: League[]; games: Record<string, SportEvent>; picks: { result?: string; start?: number; eventId: string; league: League }[] },
  force = false,
): Job[] {
  const today = startOfDay(now);
  const liveKeys = new Set<string>();
  for (const g of Object.values(state.games)) {
    if (!isLiveOrSoon(g, now)) continue;
    liveKeys.add(gameSource.get(g.id)?.key ?? `${g.league}|${ymd(new Date(startOfDay(g.start)))}`);
  }
  const jobs: Job[] = [];
  const queued = new Set<string>();
  const consider = (league: League, dates: string, maxAge: number) => {
    const key = `${league}|${dates}`;
    if (queued.has(key)) return;
    const s = ks(key);
    if (s.inFlight) return;
    const age = now - s.okAt;
    // Forced polls (mount, manual refresh) still skip keys fetched in the last 10s, so StrictMode's
    // double effect or a double click doesn't double the requests. Backoff applies unless forced.
    const due = force ? age >= 10_000 : age >= maxAge && now - s.attemptAt >= backoffMs(s.failures);
    if (!due) return;
    queued.add(key);
    jobs.push({ league, dates, key });
  };
  const days = dayStarts(now).sort((a, b) => Math.abs(a - today) - Math.abs(b - today)); // today first
  for (const day of days) {
    for (const league of state.leagues) {
      const dates = ymd(new Date(day));
      const live = liveKeys.has(`${league}|${dates}`);
      const maxAge = live ? 30_000 : day === today ? 3 * MIN : day < today ? 6 * HOUR : 30 * MIN;
      consider(league, dates, maxAge);
    }
  }
  // Open picks whose game has aged out of the window still need a final score to grade.
  for (const p of state.picks) {
    if (p.result || !p.start || p.start > now || state.games[p.eventId]) continue;
    for (const d of pickDates(p.start)) consider(p.league, d, 30 * MIN);
  }
  return jobs;
}

async function pollSports(force = false) {
  const now = Date.now();
  const { leagues, games, picks } = useApp.getState();
  const jobs = planJobs(now, { leagues, games, picks }, force);
  if (!jobs.length) return;
  for (const j of jobs) {
    const s = ks(j.key);
    s.inFlight = true;
    s.attemptAt = now;
  }
  const results = await Promise.allSettled(
    jobs.map(async (j) => {
      const startedAt = Date.now();
      const s = ks(j.key);
      try {
        const evs = await scoreboardFor(j.league, j.dates);
        s.okAt = Date.now();
        s.failures = 0;
        return { j, startedAt, evs };
      } catch (e) {
        s.failures++;
        throw e;
      } finally {
        s.inFlight = false;
      }
    }),
  );
  // Merge into the CURRENT games; a response never replaces data from a fetch that started later.
  const next: Record<string, SportEvent> = { ...useApp.getState().games };
  let errors = 0;
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      errors++;
      continue;
    }
    const { j, startedAt, evs } = r.value;
    for (const e of evs) {
      const src = gameSource.get(e.id);
      if (src && src.startedAt > startedAt) continue;
      next[e.id] = e;
      gameSource.set(e.id, { key: j.key, startedAt });
    }
  }
  gradePicks(next);
  // Drop games outside the window and leagues that were disabled.
  const lo = startOfDay(Date.now()) - (DAYS_BACK + 1) * 24 * HOUR;
  const enabled = new Set(useApp.getState().leagues);
  for (const [id, g] of Object.entries(next)) {
    if (g.start < lo || !enabled.has(g.league)) {
      delete next[id];
      gameSource.delete(id);
    }
  }
  useApp.setState({
    games: next,
    sportsUpdated: Date.now(),
    sportsError: errors === results.length ? 'Live scores unavailable (offline?)' : undefined,
  });
}

/** Period at which a league's game is in overtime / extra innings. */
const OT_PERIOD: Partial<Record<League, number>> = { nfl: 5, ncaaf: 5, nba: 5, wnba: 5, ncaam: 3, nhl: 4, mlb: 10 };
const clutchBucket = (g: SportEvent) => (g.period >= (OT_PERIOD[g.league] ?? Infinity) ? 'ot' : 'late');

/** Mounted once at the app root: data polling + alert detection. */
export function useEngine() {
  const prevGames = useRef<Record<string, SportEvent>>({});
  const alerted = useRef(new Set<string>());
  /** Reminders already shown; a ref so StrictMode's effect re-run doesn't fire them twice. */
  const fired = useRef(new Set<string>());
  const leagues = useApp((s) => s.leagues);
  const hydrated = useApp((s) => s.hydrated);
  const fantasyCfg = useApp((s) => s.fantasy);

  // Sports polling
  useEffect(() => {
    if (!hydrated) return;
    void pollSports(true);
    const t = setInterval(() => void pollSports(), 15_000);
    const onVis = () => document.visibilityState === 'visible' && void pollSports();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [hydrated, leagues]);

  // Fantasy polling (live points move every play)
  useEffect(() => {
    if (!hydrated || !fantasyCfg?.leagueId) return;
    void useFantasy.getState().refresh();
    const t = setInterval(() => {
      const live = Object.values(useApp.getState().games).some((g) => g.league === 'nfl' && g.state === 'in');
      if (live || Date.now() - (useFantasy.getState().updated ?? 0) > 10 * MIN) void useFantasy.getState().refresh();
    }, 60_000);
    return () => clearInterval(t);
  }, [hydrated, fantasyCfg?.leagueId, fantasyCfg?.userId]);

  // React to game updates: clutch alerts, red zone alerts, pick grading, rule expansion.
  useEffect(
    () =>
      useApp.subscribe((s, prev) => {
        if (s.games === prev.games) return;
        const app = useApp.getState();
        const before = prevGames.current;
        const fantasy = useFantasy.getState();
        const myTeams = new Set<string>();
        if (fantasy.matchup) for (const id of fantasy.matchup.me.starters) {
          const t = fantasy.players[id]?.team;
          if (t) myTeams.add(t);
        }

        for (const g of Object.values(s.games)) {
          const old = before[g.id];
          if (!old) continue; // first sighting: don't alert on stale state
          const hidden = app.settings.spoilerShield && !app.settings.revealed.includes(g.id);

          // Clutch
          const c = clutchInfo(g);
          // Alert on becoming clutch, and again when a clutch game moves into overtime (late → ot).
          const bucket = clutchBucket(g);
          const key = `clutch:${g.id}:${bucket}`;
          const enteredBucket = !clutchInfo(old).clutch || clutchBucket(old) !== bucket;
          if (app.settings.clutchAlerts && c.clutch && enteredBucket && !alerted.current.has(key)) {
            alerted.current.add(key);
            const watching = app.favTeams.some((t) => t === `${g.league}:${g.home.abbr}` || t === `${g.league}:${g.away.abbr}`);
            const m = matchBroadcasts(g.broadcasts, app.channels, app.networkOverrides);
            const title = `CLUTCH · ${leagueLabel(g.league)} ${g.away.abbr} @ ${g.home.abbr}`;
            const body = hidden ? c.reason ?? 'Close game, late' : `${g.away.abbr} ${g.awayScore} – ${g.home.abbr} ${g.homeScore} · ${g.statusText} · ${c.reason}`;
            app.toast({ kind: 'clutch', title, body, action: m ? { label: `Tune ${m.channel.name}`, run: () => useApp.getState().tune(m.channel.id) } : undefined });
            if (app.settings.notifications) void notify(title, body);
            if (app.settings.autoSwitch && m && (watching || c.score >= 85)) useApp.getState().tune(m.channel.id);
          }

          // Red zone for my fantasy starters' teams
          if (g.league === 'nfl' && g.situation?.isRedZone && !old.situation?.isRedZone) {
            const pos = g.situation.possessionTeamId === g.home.id ? g.home : g.situation.possessionTeamId === g.away.id ? g.away : undefined;
            // One alert per drive: the red-zone flag can flap between polls.
            const rzKey = `rz:${g.id}:${g.period}:${g.situation.possessionTeamId ?? ''}`;
            if (pos && myTeams.has(pos.abbr) && !alerted.current.has(rzKey)) {
              alerted.current.add(rzKey);
              const names = fantasy.matchup!.me.starters.map((id) => fantasy.players[id]).filter((p) => p?.team === pos.abbr).map((p) => p!.name);
              const m = matchBroadcasts(g.broadcasts, app.channels, app.networkOverrides);
              app.toast({
                kind: 'redzone',
                title: `RED ZONE · ${pos.abbr} driving`,
                body: `Your guys: ${names.join(', ')}${g.situation.text ? ' · ' + g.situation.text : ''}`,
                action: m ? { label: `Tune ${m.channel.name}`, run: () => useApp.getState().tune(m.channel.id) } : undefined,
              });
              if (app.settings.notifications) void notify(`Red zone: ${pos.abbr}`, names.join(', '));
            }
          }
        }

        // Expand team rules into schedule entries
        const teamRules = app.rules.filter((r) => r.enabled && r.kind === 'team');
        if (teamRules.length) addRuleEntries();

        prevGames.current = s.games;
      }),
    [],
  );

  // Reminders + title/block rules: check every 30s.
  useEffect(() => {
    if (!hydrated) return;
    const tick = () => {
      const app = useApp.getState();
      const now = Date.now();
      for (const e of app.schedule) {
        if (e.reminderMin == null) continue;
        const at = e.start - e.reminderMin * MIN;
        const key = `${e.id}:${e.start}`;
        if (now >= at && now < e.start + 5 * MIN && !fired.current.has(key)) {
          fired.current.add(key);
          const game = e.eventId ? app.games[e.eventId] : undefined;
          const m = game ? matchBroadcasts(game.broadcasts, app.channels, app.networkOverrides) : undefined;
          const chId = e.channelId ?? m?.channel.id;
          const mins = Math.max(0, Math.round((e.start - now) / MIN));
          app.toast({
            kind: 'reminder',
            title: mins ? `Starts in ${mins} min` : 'Starting now',
            body: e.title,
            action: chId ? { label: 'Watch', run: () => useApp.getState().tune(chId) } : undefined,
          });
          if (app.settings.notifications) void notify(e.title, mins ? `Starts in ${mins} min` : 'Starting now');
        }
      }
      addRuleEntries();
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [hydrated]);
}

/** Grade open picks against final scores. */
function gradePicks(games: Record<string, SportEvent>) {
  const picks = useApp.getState().picks;
  if (!picks.some((p) => !p.result)) return;
  let changed = false;
  const graded = picks.map((p) => {
    if (p.result) return p;
    const r = gradePick(p, games[p.eventId]);
    if (!r) return p;
    changed = true;
    return { ...p, result: r };
  });
  if (changed) useApp.setState({ picks: graded });
}

/**
 * Merge rule-generated entries into the schedule: add new ones (not dismissed, not already
 * present by id — or for title rules by rule+title+start, whichever channel it was taken from),
 * and move existing rule-generated game entries when the game time changes.
 * Returns the same array when nothing changed.
 */
export function mergeRuleEntries(schedule: ScheduleEntry[], generated: ScheduleEntry[], dismissed: string[]): ScheduleEntry[] {
  const byId = new Map(schedule.map((e) => [e.id, e]));
  const dismissedSet = new Set(dismissed);
  const slot = (e: ScheduleEntry) => `${e.ruleId}|${e.title.toLowerCase()}|${e.start}`;
  const programSlots = new Set(schedule.filter((e) => e.ruleId && e.programId).map(slot));
  const updates = new Map<string, ScheduleEntry>();
  const add: ScheduleEntry[] = [];
  for (const g of generated) {
    if (dismissedSet.has(g.id)) continue;
    const cur = byId.get(g.id);
    if (cur) {
      if (cur.ruleId && g.id.startsWith('game:') && (cur.start !== g.start || cur.end !== g.end)) {
        updates.set(g.id, { ...cur, start: g.start, end: g.end });
      }
      continue;
    }
    if (g.programId && programSlots.has(slot(g))) continue;
    if (g.programId) programSlots.add(slot(g));
    byId.set(g.id, g);
    add.push(g);
  }
  if (!add.length && !updates.size) return schedule;
  return [...schedule.map((e) => updates.get(e.id) ?? e), ...add];
}

/** Materialize rule-generated entries for the next 7 days (deterministic ids, so no duplicates). */
export function addRuleEntries() {
  const app = useApp.getState();
  if (!app.rules.some((r) => r.enabled)) return;
  const from = startOfDay(Date.now());
  const generated = applyRules(app.rules, { games: Object.values(app.games), programs: app.programs, from, to: from + 7 * 24 * HOUR });
  const next = mergeRuleEntries(app.schedule, generated, app.dismissed);
  if (next !== app.schedule) useApp.setState({ schedule: next });
}

export { pollSports };

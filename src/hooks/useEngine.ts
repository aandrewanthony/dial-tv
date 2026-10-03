import { useEffect, useRef } from 'react';
import { useApp } from '../store/app';
import { useFantasy } from '../store/fantasy';
import { espnProvider } from '../providers/espn';
import type { League, SportEvent } from '../types';
import { clutchInfo, gradePick, leagueLabel } from '../lib/sports';
import { matchBroadcasts } from '../lib/channelMatch';
import { applyRules, HOUR, MIN, startOfDay } from '../lib/scheduler';
import { notify } from '../lib/notify';

const DAYS_BACK = 1;
const DAYS_AHEAD = 6;

/** key `${league}|${dayStart}` → last fetch time */
const fetchedAt = new Map<string, number>();

function dayStarts() {
  const today = startOfDay(Date.now());
  const out: number[] = [];
  for (let d = -DAYS_BACK; d <= DAYS_AHEAD; d++) out.push(startOfDay(today + d * 24 * HOUR + 2 * HOUR));
  return out;
}

async function pollSports(force = false) {
  const { leagues, games } = useApp.getState();
  const today = startOfDay(Date.now());
  const anyLiveOrSoon = Object.values(games).some(
    (g) => g.state === 'in' || (g.state === 'pre' && g.start - Date.now() < 15 * MIN && g.start > Date.now() - HOUR),
  );
  const jobs: { league: League; day: number }[] = [];
  for (const league of leagues) {
    for (const day of dayStarts()) {
      const key = `${league}|${day}`;
      const age = Date.now() - (fetchedAt.get(key) ?? 0);
      const isToday = day === today;
      const maxAge = isToday ? (anyLiveOrSoon ? 30_000 : 3 * MIN) : day < today ? 6 * HOUR : 30 * MIN;
      if (force || age >= maxAge) jobs.push({ league, day });
    }
  }
  // Open picks whose game has aged out of the window still need a final score to grade.
  for (const p of useApp.getState().picks) {
    if (p.result || !p.start || games[p.eventId]?.state === 'post' || p.start > Date.now()) continue;
    const day = startOfDay(p.start);
    const key = `${p.league}|${day}`;
    if (Date.now() - (fetchedAt.get(key) ?? 0) > 30 * MIN && !jobs.some((j) => j.league === p.league && j.day === day)) jobs.push({ league: p.league, day });
  }
  if (!jobs.length) return;
  // Today first so the UI fills quickly.
  jobs.sort((a, b) => Math.abs(a.day - today) - Math.abs(b.day - today));
  const results = await Promise.allSettled(
    jobs.map(async (j) => {
      const evs = await espnProvider.scoreboard(j.league, new Date(j.day));
      fetchedAt.set(`${j.league}|${j.day}`, Date.now());
      return evs;
    }),
  );
  const next: Record<string, SportEvent> = { ...useApp.getState().games };
  let errors = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') for (const e of r.value) next[e.id] = e;
    else errors++;
  }
  gradePicks(next);
  // Drop games outside the window and leagues that were disabled.
  const lo = today - (DAYS_BACK + 1) * 24 * HOUR;
  const enabled = new Set(useApp.getState().leagues);
  for (const [id, g] of Object.entries(next)) if (g.start < lo || !enabled.has(g.league)) delete next[id];
  useApp.setState({
    games: next,
    sportsUpdated: Date.now(),
    sportsError: errors === results.length ? 'Live scores unavailable (offline?)' : undefined,
  });
}

/** Mounted once at the app root: data polling + alert detection. */
export function useEngine() {
  const prevGames = useRef<Record<string, SportEvent>>({});
  const alerted = useRef(new Set<string>());
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
          const key = `clutch:${g.id}:${g.period >= 5 ? 'ot' : 'late'}`;
          if (app.settings.clutchAlerts && c.clutch && !clutchInfo(old).clutch && !alerted.current.has(key)) {
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
            if (pos && myTeams.has(pos.abbr)) {
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
    const fired = new Set<string>();
    const tick = () => {
      const app = useApp.getState();
      const now = Date.now();
      for (const e of app.schedule) {
        if (e.reminderMin == null) continue;
        const at = e.start - e.reminderMin * MIN;
        const key = `${e.id}:${e.start}`;
        if (now >= at && now < e.start + 5 * MIN && !fired.has(key)) {
          fired.add(key);
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

/** Materialize rule-generated entries for the next 7 days (deterministic ids, so no duplicates). */
export function addRuleEntries() {
  const app = useApp.getState();
  if (!app.rules.some((r) => r.enabled)) return;
  const from = startOfDay(Date.now());
  const generated = applyRules(app.rules, { games: Object.values(app.games), programs: app.programs, from, to: from + 7 * 24 * HOUR });
  const have = new Set(app.schedule.map((e) => e.id));
  const dismissed = new Set(app.dismissed);
  const add = generated.filter((e) => !have.has(e.id) && !dismissed.has(e.id));
  if (add.length) useApp.setState({ schedule: [...app.schedule, ...add] });
}

export { pollSports };

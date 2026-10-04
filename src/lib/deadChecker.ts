/**
 * The background dead-channel checker (Settings → Channels → Hide dead channels).
 *
 * Gentle with providers, which often allow only 1–2 connections and ban accounts that hammer them:
 *  - one request at a time, at most one every 15 s, at most 400 a day (manual re-checks excepted);
 *  - never while anything plays (Live TV, Multiview, movies, a recording in progress), and not in
 *    the first minute after playback stops; a check in flight is aborted the moment playback starts;
 *  - "too many requests" answers pause that provider for 6 h; five failures in a row on one provider
 *    are undone and the provider paused, until a link that worked before proves it's up again.
 * Order: confirm links that failed once (6 h later), then unchecked links in the visible lineup
 * order, then dead links (revival, daily), then working links (every 3 days). Within a merged
 * channel only the first variant is checked unless the ones before it are failing.
 * State is persisted per URL hash (store/streamHealth.ts), so it resumes across restarts.
 */
import { lineupBeforeHealth, useApp } from '../store/app';
import { useChannelPrefs } from '../store/channelPrefs';
import { bumpHealthVersion, setOrigin, setUrlHealth, useStreamHealth } from '../store/streamHealth';
import { useDvr } from './dvr';
import { isDesktop } from './net';
import {
  HOUR, channelUrls, checkStream, checkableHere, dueInfo, isDeadHealth, urlKey, withResult, type UrlHealth,
} from './streamHealth';
import type { OrgChannel } from './channelOrg';

export const CHECK_INTERVAL = 15_000;
export const DAILY_CAP = 400;
/** Quiet time after playback stops before the next check (the provider may still count the connection). */
const AFTER_PLAY = 60_000;
const FAIL_STREAK = 5;
const RATE_PAUSE = 6 * HOUR;
const OUTAGE_PAUSE = HOUR;
const CORS_RETRY = 7 * 24 * HOUR;
/** Entries for links not seen in any playlist for this long are dropped. */
const FORGET = 60 * 24 * HOUR;

// ---------------------------------------------------------------- playback holds

let holds = 0;
let lastPlayEnd = 0;
let current: AbortController | null = null;
let pendingBump = false;

/** Anything that streams (players) holds the checker off while mounted. Returns the release. */
export function holdPlayback(): () => void {
  holds++;
  current?.abort();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (!holds) {
      lastPlayEnd = Date.now();
      if (pendingBump) { pendingBump = false; bumpHealthVersion(); }
    }
  };
}

const recording = () => useDvr.getState().recordings.some((r) => r.status === 'recording' || r.live);
export const isPlaybackBusy = () => holds > 0 || recording();

/**
 * The player got a stream playing: proof the link works. Revives a link the checker had flagged.
 * The lineup re-filters only after playback stops, so the playing channel is never re-shuffled.
 */
export function reportStreamOk(url: string) {
  const key = urlKey(url);
  const h = useStreamHealth.getState().urls[key];
  if (!h || (!h.fails && h.lastOk && Date.now() - h.lastOk < HOUR)) return;
  const wasDead = isDeadHealth(h);
  setUrlHealth(key, withResult(h, 'ok', Date.now()), { bump: false });
  if (wasDead) pendingBump = true;
}

// ---------------------------------------------------------------- picking the next link

interface Job { url: string; key: string; channel: OrgChannel; origin: string; manual?: { id: string; at: number }; canary?: boolean }

const originOf = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

function originUsable(origin: string, now: number): boolean {
  const o = useStreamHealth.getState().origins[origin];
  if (!o) return true;
  if (o.pauseUntil && o.pauseUntil > now) return false;
  if (!isDesktop() && o.cors === 'blocked' && (o.corsAt ?? 0) + CORS_RETRY > now) return false;
  return true;
}

function nextJob(list: OrgChannel[], now: number, capped: boolean): Job | null {
  const st = useStreamHealth.getState();
  // 1. Channels the user asked to re-check.
  const byId = new Map(list.map((c) => [c.id, c]));
  const done: string[] = [];
  let manual: Job | null = null;
  for (const r of st.recheck) {
    const c = byId.get(r.id);
    const left = c ? channelUrls(c).filter((u) => checkableHere(u, c) && (st.urls[urlKey(u)]?.lastCheck ?? 0) < r.at) : [];
    if (!left.length) { done.push(r.id); continue; } // every link checked since the request (or none checkable)
    const url = left.find((u) => originUsable(originOf(u), now));
    if (url && c) { manual = { url, key: urlKey(url), channel: c, origin: originOf(url), manual: r }; break; }
  }
  if (done.length) useStreamHealth.setState((s) => ({ recheck: s.recheck.filter((r) => !done.includes(r.id)) }));
  if (manual) return manual;
  if (capped) return null;
  // 2. A provider that just had a run of failures: try a link that worked before.
  const canaryFor = new Set(Object.entries(st.origins).filter(([o, s]) => s.needCanary && originUsable(o, now)).map(([o]) => o));
  let canary: Job | null = null;
  let canaryOk = 0;
  // 3. The most urgent due link, first in lineup order within a tier.
  let best: Job | null = null;
  let bestTier = 99;
  for (const c of list) {
    for (const url of channelUrls(c)) {
      if (!checkableHere(url, c)) continue;
      const key = urlKey(url);
      const h = st.urls[key];
      const origin = originOf(url);
      if (canaryFor.has(origin) && h?.lastOk && !h.fails && h.lastOk > canaryOk) {
        canaryOk = h.lastOk;
        canary = { url, key, channel: c, origin, canary: true };
      }
      const { at, tier } = dueInfo(h);
      if (tier < bestTier && at <= now && !canaryFor.has(origin) && originUsable(origin, now)) {
        best = { url, key, channel: c, origin };
        bestTier = tier;
      }
      // A link that isn't failing makes the channel's later variants irrelevant.
      if (!h || !h.fails) break;
    }
    if (bestTier === 0 && !canaryFor.size) break;
  }
  if (canary) return canary;
  // Paused providers with no known-good link to test: nothing to compare against, count normally.
  for (const o of canaryFor) setOrigin(o, { needCanary: false, trustUntil: now + 24 * HOUR });
  return best;
}

// ---------------------------------------------------------------- the loop

/** Failures in a row per provider since its last success: [key, health before]. */
const streaks = new Map<string, [string, UrlHealth | undefined][]>();
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let lastRun = 0;
let pruned = false;

function canRun(now: number): boolean {
  if (!useChannelPrefs.getState().hideDead) return false;
  if (!useChannelPrefs.getState().hydrated || !useStreamHealth.getState().hydrated || !useApp.getState().hydrated) return false;
  if (isPlaybackBusy() || now - lastPlayEnd < AFTER_PLAY) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return true;
}

function prune(list: OrgChannel[], now: number) {
  pruned = true;
  const live = new Set<string>();
  for (const c of list) for (const u of channelUrls(c)) live.add(urlKey(u));
  useStreamHealth.setState((s) => {
    const urls = { ...s.urls };
    for (const [k, h] of Object.entries(urls)) if (!live.has(k) && (h.lastCheck ?? 0) + FORGET < now) delete urls[k];
    return { urls };
  });
}

async function tick() {
  timer = undefined;
  const now = Date.now();
  try {
    if (!canRun(now) || now - lastRun < CHECK_INTERVAL) return;
    const app = useApp.getState();
    const list = lineupBeforeHealth(app, false);
    if (!list.length) return;
    if (!pruned) prune(list, now);
    const st = useStreamHealth.getState();
    if (st.day !== today()) useStreamHealth.setState({ day: today(), dayCount: 0 });
    const capped = useStreamHealth.getState().dayCount >= DAILY_CAP;
    const job = nextJob(list, now, capped);
    if (!job) return;
    lastRun = now;
    const ctrl = new AbortController();
    current = ctrl;
    const res = await checkStream(job.url, job.channel, ctrl.signal);
    if (current === ctrl) current = null;
    if (res.kind === 'aborted') { lastRun = 0; return; }
    useStreamHealth.setState((s) => ({ dayCount: s.dayCount + 1 }));
    record(job, res, Date.now());
  } catch {
    /* never let the loop die */
  } finally {
    schedule();
  }
}

function record(job: Job, res: Awaited<ReturnType<typeof checkStream>>, now: number) {
  const st = useStreamHealth.getState();
  const h = st.urls[job.key];
  const o = st.origins[job.origin];
  const dropManual = () => job.manual && useStreamHealth.setState((s) => ({ recheck: s.recheck.filter((r) => r.id !== job.manual!.id) }));
  if (res.kind === 'ok') {
    setUrlHealth(job.key, withResult(h, 'ok', now));
    streaks.delete(job.origin);
    const patch: Record<string, unknown> = {};
    if (!isDesktop() && o?.cors !== 'ok') Object.assign(patch, { cors: 'ok', corsAt: now });
    if (job.canary) Object.assign(patch, { needCanary: false, trustUntil: now + 24 * HOUR });
    if (Object.keys(patch).length) setOrigin(job.origin, patch);
    dropManual();
    return;
  }
  if (res.kind === 'skip') {
    setUrlHealth(job.key, withResult(h, 'skip', now));
    if (res.cors) setOrigin(job.origin, { cors: 'blocked', corsAt: now });
    if (res.slow) setOrigin(job.origin, { pauseUntil: now + RATE_PAUSE });
    return;
  }
  if (res.kind !== 'fail') return;
  // Web: a timeout from a host never seen answering a browser could be CORS; don't count it.
  if (!isDesktop() && res.why === 'timeout' && o?.cors !== 'ok') {
    setUrlHealth(job.key, withResult(h, 'skip', now));
    return;
  }
  if (job.canary) {
    // The known-good link fails too: the provider is down (or refusing us). Undo nothing more, wait.
    setUrlHealth(job.key, { ...(h ?? { fails: 0 }), lastCheck: now });
    setOrigin(job.origin, { pauseUntil: now + RATE_PAUSE, needCanary: true });
    return;
  }
  setUrlHealth(job.key, withResult(h, 'fail', now, res.why));
  if ((o?.trustUntil ?? 0) > now) return;
  const streak = streaks.get(job.origin) ?? [];
  if (!streak.some(([k]) => k === job.key)) streak.push([job.key, h]);
  streaks.set(job.origin, streak);
  if (streak.length >= FAIL_STREAK) {
    // Many links on one provider failing back to back looks like an outage or an account problem,
    // not dead channels: undo those failures (keep the time so they aren't retried at once) and pause.
    for (const [k, prev] of streak) setUrlHealth(k, { ...(prev ?? { fails: 0 }), lastCheck: now });
    streaks.delete(job.origin);
    setOrigin(job.origin, { pauseUntil: now + OUTAGE_PAUSE, needCanary: true });
  }
}

function schedule(delay = CHECK_INTERVAL) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), delay);
}

/** Start the checker loop (once). It idles while the setting is off. */
export function startDeadChecker() {
  if (started || typeof window === 'undefined') return;
  started = true;
  // A recording starting stops a check in flight, like playback does.
  useDvr.subscribe(() => { if (recording()) current?.abort(); });
  // Turning the feature off stops a check in flight.
  useChannelPrefs.subscribe((s) => { if (!s.hideDead) current?.abort(); });
  schedule(20_000);
}

/**
 * Guide (EPG) state: the cached guide, manual/automatic refresh, and the mapping from playlist
 * channels to guide channels.
 *
 * - Nothing is downloaded at startup: the guide comes from its IndexedDB cache (workers/guideDb.ts).
 *   Downloads happen when the user presses "Load guide" / "Refresh guide", or — only if the user
 *   picked "Once a day" / "Every 12 hours" — once in the background when the cache is older than that.
 * - Downloading, gunzip, parsing, matching and windowing run in a Web Worker (workers/epg.worker.ts).
 * - Programmes are stored once per guide channel. Playlist channels resolve to a guide channel
 *   (tvg-id → name → normalized name → manual mapping) and share its listings: `useApp.programs`
 *   holds each programme once (channelId = the first playlist channel showing it) and
 *   `programsByChannel()` serves every playlist channel id through registerProgramIndex().
 */
import { create } from 'zustand';
import type { Channel, Program } from '../types';
import { isLive, orderedChannels, registerProgramIndex, useApp } from './app';
import { isDesktop } from '../lib/net';
import { decodeGuide, DEFAULT_DAYS, EpgMatcher, rowFields, type DecodedGuide, type GuideCache, type GuideSourceMeta, type Resolved } from '../workers/epgCore';
import { clearGuideCache, readGuideCache, readGuidePrefs, writeGuidePrefs } from '../workers/guideDb';
import { runGuideJob, type GuideJobProgress, type GuideJobRequest, type GuideJobSource } from '../workers/guideJob';

export type GuideRefresh = 'manual' | 'daily' | '12h';
export type PlaylistRefresh = 'manual' | 'daily';

export const REFRESH_MS: Record<GuideRefresh, number> = { manual: Infinity, daily: 24 * 3600_000, '12h': 12 * 3600_000 };

export interface GuidePrefs {
  /** Guide download policy. Manual = only when the user asks. */
  refresh: GuideRefresh;
  /** Days of listings to keep (1–7). */
  days: number;
  /** Playlist re-download policy (a newly added playlist always loads right away). */
  playlistRefresh: PlaylistRefresh;
}

const DEFAULT_PREFS: GuidePrefs = { refresh: 'manual', days: DEFAULT_DAYS, playlistRefresh: 'manual' };

/** Guide preferences, saved in the guide's own database (workers/guideDb.ts). */
export const useGuidePrefs = Object.assign(create<GuidePrefs>(() => ({ ...DEFAULT_PREFS })), { ready: Promise.resolve() });
useGuidePrefs.ready = (async () => {
  try {
    const stored = await readGuidePrefs<Partial<GuidePrefs>>();
    if (stored && typeof stored === 'object') useGuidePrefs.setState({ ...DEFAULT_PREFS, ...stored });
  } catch {
    return; // unreadable: run on defaults and never overwrite what's stored
  }
  useGuidePrefs.subscribe((v) => void writeGuidePrefs({ refresh: v.refresh, days: v.days, playlistRefresh: v.playlistRefresh }).catch(() => undefined));
})();

export interface GuideState {
  /** The cache has been read (or found missing) at least once. */
  ready: boolean;
  loaded: boolean;
  loading: boolean;
  loadedAt?: number;
  days?: number;
  /** Listings end at this instant (epoch ms). */
  until?: number;
  programmes: number;
  scanned: number;
  epgChannels: number;
  storedChannels: number;
  /** Live playlist channels with listings / total live playlist channels. */
  matched: number;
  liveChannels: number;
  /** Channels resolved to a guide channel whose listings were not downloaded (mapped after the last load). */
  needsReload: number;
  progress?: GuideJobProgress & { startedAt: number };
  error?: string;
  sources: GuideSourceMeta[];
  /** Bumped whenever the mapping is recomputed. */
  rev: number;
  /** Milliseconds the last load took (download → stored), for diagnostics. */
  lastLoadMs?: number;
}

export const useGuide = create<GuideState>(() => ({
  ready: false,
  loaded: false,
  loading: false,
  programmes: 0,
  scanned: 0,
  epgChannels: 0,
  storedChannels: 0,
  matched: 0,
  liveChannels: 0,
  needsReload: 0,
  sources: [],
  rev: 0,
}));

// ---------- module state ----------

let decoded: DecodedGuide | null = null;
let matcher: EpgMatcher | null = null;
let resolved = new Map<string, Resolved>();
/** guide channel key → its programmes (built for one representative playlist channel id). */
let lists = new Map<string, { rep: string; list: Program[] }>();
let remapSeq = 0;
let unsubscribe: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

/** Live channels from the app store, in store order. */
const liveChannels = (): Channel[] => useApp.getState().channels.filter(isLive);

export const enabledEpgSources = () => useApp.getState().epgSources.filter((e) => e.enabled);

/** Matching info for the mapping UI (recomputed on every remap; read after `rev` changes). */
export function guideMatch() {
  return { matcher, resolved, decoded, hasListings: (key: string) => lists.has(key) };
}

/** Rebuild useApp.programs from the cached guide for the current channels / mapping / enabled sources. */
export async function remap(): Promise<void> {
  const seq = ++remapSeq;
  const app = useApp.getState();
  const live = liveChannels();
  if (!decoded || !matcher) {
    resolved = new Map();
    lists = new Map();
    const empty: Program[] = [];
    registerProgramIndex(empty, new Map());
    useApp.setState({ programs: empty });
    useGuide.setState((s) => ({ matched: 0, liveChannels: live.length, needsReload: 0, rev: s.rev + 1 }));
    return;
  }
  const g = decoded;
  const enabledIdx = new Set<number>();
  const enabledIds = new Set(app.epgSources.filter((e) => e.enabled).map((e) => e.id));
  g.cache.sources.forEach((s, i) => {
    if (enabledIds.has(s.id)) enabledIdx.add(i);
  });
  const keyIdx = new Map<string, number>();
  g.channels.forEach((c, i) => keyIdx.set(c.id, i));

  const res = matcher.resolveAll(live, app.epgManual);
  const repOf = new Map<string, string>();
  let needsReload = 0;
  for (const c of live) {
    const r = res.get(c.id);
    if (!r) continue;
    const ci = keyIdx.get(r.key);
    const ch = ci == null ? undefined : g.channels[ci];
    if (ch?.s == null || !enabledIdx.has(ch.s) || !g.ranges.has(ci!)) {
      // Mapped to a guide channel whose listings weren't downloaded (nobody wanted it at load time).
      if (ch && !ch.w) needsReload++;
      continue;
    }
    if (!repOf.has(r.key)) repOf.set(r.key, c.id);
  }

  const next = new Map<string, { rep: string; list: Program[] }>();
  let work = 0;
  for (const [key, rep] of repOf) {
    const prev = lists.get(key);
    if (prev && prev.rep === rep) {
      next.set(key, prev);
      continue;
    }
    const [a, b] = g.ranges.get(keyIdx.get(key)!)!;
    const list: Program[] = new Array(b - a);
    for (let r = a; r < b; r++) {
      const f = rowFields(g, r);
      list[r - a] = { id: `${rep}|${f.start}`, channelId: rep, ...f };
    }
    next.set(key, { rep, list });
    work += b - a;
    if (work > 15000) {
      // Materialize in slices so the main thread never blocks for long.
      work = 0;
      await yieldToMain();
      if (seq !== remapSeq) return;
    }
  }
  if (seq !== remapSeq) return;

  const programs: Program[] = [];
  for (const { list } of next.values()) for (let i = 0; i < list.length; i++) programs.push(list[i]);
  const index = new Map<string, Program[]>();
  let matched = 0;
  for (const c of live) {
    const r = res.get(c.id);
    const l = r && next.get(r.key);
    if (l) {
      index.set(c.id, l.list);
      matched++;
    }
  }
  // Count what the user sees: merged logical channels (Settings → Channels), when available.
  let shownTotal = live.length;
  try {
    const shown = orderedChannels(useApp.getState(), true);
    if (shown.length) {
      shownTotal = shown.length;
      matched = shown.filter((c) => index.has(c.id)).length;
    }
  } catch {
    /* keep the raw counts */
  }
  const usedKeys = new Set([...res.values()].map((r) => r.key));
  const unmatchedEpg = g.channels.filter((c) => c.s != null && !usedKeys.has(c.id)).map((c) => ({ id: c.id, name: c.names[0] ?? c.id }));
  lists = next;
  resolved = res;
  registerProgramIndex(programs, index);
  useApp.setState({ programs, unmatchedEpg });
  useGuide.setState((s) => ({ matched, liveChannels: shownTotal, needsReload, rev: s.rev + 1 }));
}

let remapTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRemap() {
  if (remapTimer) clearTimeout(remapTimer);
  remapTimer = setTimeout(() => {
    remapTimer = null;
    void remap();
  }, 30);
}

function applyCache(cache: GuideCache | undefined) {
  if (!cache) {
    decoded = null;
    matcher = null;
    useApp.setState({ xmltvChannels: [] });
    useGuide.setState({ loaded: false, loadedAt: undefined, until: undefined, programmes: 0, scanned: 0, epgChannels: 0, storedChannels: 0, sources: [] });
    return remap();
  }
  decoded = decodeGuide(cache);
  matcher = new EpgMatcher(decoded.channels);
  lists = new Map();
  useApp.setState({ xmltvChannels: decoded.channels.map((c) => ({ id: c.id, name: c.names[0] ?? c.id })) });
  useGuide.setState({
    loaded: true,
    loadedAt: cache.savedAt,
    days: cache.days,
    until: cache.to,
    programmes: decoded.count,
    scanned: cache.scanned,
    epgChannels: decoded.channels.length,
    storedChannels: decoded.ranges.size,
    sources: cache.sources,
  });
  return remap();
}

const enabledKey = (s: { epgSources: { id: string; enabled: boolean }[] }) => s.epgSources.filter((e) => e.enabled).map((e) => e.id).join('\n');

/** Startup: read the cached guide (no network), keep the mapping in sync, and arm the refresh policy. */
export async function initGuide(): Promise<void> {
  unsubscribe?.();
  unsubscribe = useApp.subscribe((s, prev) => {
    if (s.channels !== prev.channels || s.epgManual !== prev.epgManual || enabledKey(s) !== enabledKey(prev)) {
      if (!s.epgSources.length && decoded) {
        // Every guide source removed: drop the cached guide too.
        void clearGuideCache().catch(() => undefined);
        void applyCache(undefined);
        return;
      }
      scheduleRemap();
    }
  });
  let cache: GuideCache | undefined;
  try {
    cache = await readGuideCache();
  } catch {
    cache = undefined;
  }
  await applyCache(cache);
  useGuide.setState({ ready: true });
  await useGuidePrefs.ready;
  maybeAutoRefresh();
  if (refreshTimer) clearInterval(refreshTimer);
  // Re-check the policy now and then while the app stays open (it only downloads when stale).
  refreshTimer = setInterval(maybeAutoRefresh, 30 * 60_000);
}

let lastAutoGuide = 0;
let lastAutoPlaylists = 0;

/**
 * Downloads only when the user chose an automatic policy and the saved copy is older than it —
 * and at most once per policy period, even when that attempt failed (never hammers a provider).
 */
export function maybeAutoRefresh() {
  const prefs = useGuidePrefs.getState();
  const g = useGuide.getState();
  const app = useApp.getState();
  if (!app.hydrated) return;
  // Playlists: optional daily refresh.
  if (prefs.playlistRefresh === 'daily' && !app.loadingSources) {
    const urls = app.playlists.filter((p) => p.enabled && (p.kind === 'm3u-url' || p.kind === 'xtream'));
    const oldest = Math.min(...urls.map((p) => p.lastLoaded ?? 0));
    if (urls.length && Date.now() - oldest > 24 * 3600_000 && Date.now() - lastAutoPlaylists > 24 * 3600_000) {
      lastAutoPlaylists = Date.now();
      void app.loadSources();
    }
  }
  if (prefs.refresh === 'manual' || g.loading || !enabledEpgSources().length) return;
  const age = g.loadedAt ? Date.now() - g.loadedAt : Infinity;
  if (age > REFRESH_MS[prefs.refresh] && Date.now() - lastAutoGuide > REFRESH_MS[prefs.refresh]) {
    lastAutoGuide = Date.now();
    void loadGuide({ background: true });
  }
}

// ---------- loading ----------

let current: { id: number; promise: Promise<boolean>; cancel: () => void } | null = null;
let jobSeq = 0;

function makeRequest(): GuideJobRequest {
  const app = useApp.getState();
  const sources: GuideJobSource[] = enabledEpgSources().map((e) => (e.kind === 'xmltv-file' ? { id: e.id, name: e.name, fileId: e.id } : { id: e.id, name: e.name, url: e.url }));
  return {
    sources,
    channels: liveChannels().map((c) => ({ id: c.id, name: c.name, tvgId: c.tvgId })),
    manual: app.epgManual,
    days: useGuidePrefs.getState().days,
    now: Date.now(),
    save: true,
    desktop: isDesktop(),
  };
}

type WorkerMsg =
  | { type: 'ready' }
  | { type: 'progress'; id: number; p: GuideJobProgress }
  | { type: 'done'; id: number; cache: GuideCache }
  | { type: 'error'; id: number; message: string; aborted?: boolean };

/** Run the job in a Web Worker; resolves null when workers are unavailable (caller falls back). */
function runInWorker(id: number, req: GuideJobRequest, onProgress: (p: GuideJobProgress) => void, setCancel: (fn: () => void) => void): Promise<GuideCache | null> {
  let worker: Worker;
  try {
    worker = new Worker(new URL('../workers/epg.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return Promise.resolve(null);
  }
  return new Promise<GuideCache | null>((resolve, reject) => {
    let started = false;
    const finish = () => worker.terminate();
    setCancel(() => worker.postMessage({ type: 'cancel', id }));
    worker.onerror = (e) => {
      e.preventDefault?.();
      finish();
      if (!started) resolve(null);
      else reject(new Error(e.message || 'Guide worker failed'));
    };
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const m = e.data;
      if (m.type === 'ready') {
        started = true;
        worker.postMessage({ type: 'load', id, req });
      } else if (m.type === 'progress') onProgress(m.p);
      else if (m.type === 'done') {
        finish();
        resolve(m.cache);
      } else if (m.type === 'error') {
        finish();
        const err = new Error(m.message);
        if (m.aborted) err.name = 'AbortError';
        reject(err);
      }
    };
  });
}

/** For tests/diagnostics: force the in-process path. */
export const guideDebug: { noWorker: boolean; mode?: 'worker' | 'main' } = { noWorker: false };

/**
 * Download and rebuild the guide now (Load guide / Refresh guide). Concurrent calls share one job.
 * Resolves true when a new guide was stored.
 */
export function loadGuide(opts: { background?: boolean } = {}): Promise<boolean> {
  if (current) return current.promise;
  const req = makeRequest();
  if (!req.sources.length) {
    useGuide.setState({ error: 'Add a guide source (XMLTV URL or file) first.' });
    return Promise.resolve(false);
  }
  const id = ++jobSeq;
  const startedAt = Date.now();
  let cancelFn: () => void = () => undefined;
  const ac = new AbortController();
  const onProgress = (p: GuideJobProgress) => useGuide.setState({ progress: { ...p, startedAt } });
  useGuide.setState({ loading: true, error: undefined, progress: { phase: 'download', sourceIndex: 0, sourceCount: req.sources.length, bytes: 0, programmes: 0, kept: 0, startedAt } });
  const promise = (async () => {
    try {
      let cache = guideDebug.noWorker || typeof Worker === 'undefined' ? null : await runInWorker(id, req, onProgress, (fn) => (cancelFn = fn));
      guideDebug.mode = cache ? 'worker' : 'main';
      if (!cache) {
        // No worker available (old webview / file:// restrictions): same job in-process, yielding between chunks.
        cancelFn = () => ac.abort();
        let last = performance.now();
        cache = await runGuideJob(req, onProgress, ac.signal, () => {
          const t = performance.now();
          if (t - last < 12) return;
          return yieldToMain().then(() => void (last = performance.now()));
        });
      }
      await applyCache(cache);
      const metaById = new Map(cache.sources.map((s) => [s.id, s]));
      useApp.setState((s) => ({
        epgSources: s.epgSources.map((e) => {
          const m = metaById.get(e.id);
          return m ? { ...e, lastLoaded: m.error ? e.lastLoaded : cache!.savedAt, programCount: m.programmes, error: m.error } : e;
        }),
      }));
      useGuide.setState({ lastLoadMs: Date.now() - startedAt });
      return true;
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError') {
        useGuide.setState({ error: err.message || String(err) });
        if (!opts.background) useApp.getState().toast({ kind: 'error', title: 'Guide could not be loaded', body: err.message });
      }
      return false;
    } finally {
      current = null;
      useGuide.setState({ loading: false, progress: undefined });
    }
  })();
  current = { id, promise, cancel: () => cancelFn() };
  return promise;
}

export function cancelGuideLoad() {
  current?.cancel();
}

/** Forget the stored guide (e.g. all guide sources removed). */
export async function clearGuide() {
  await clearGuideCache().catch(() => undefined);
  await applyCache(undefined);
}

// ---------- status text ----------

const nf = new Intl.NumberFormat();
export const fmtCount = (n: number) => nf.format(n);
const fmtMB = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : fmtCount(n));

function fmtWhen(t: number) {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  const y = new Date(today.getTime() - 86400_000);
  if (d.toDateString() === y.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** "Guide loaded 2:14 PM · 1,240 of 1,380 channels matched · 3 days" */
export function guideStatusText(s: GuideState): string {
  if (!s.loaded) return 'Guide not loaded';
  const parts = [`Guide loaded ${fmtWhen(s.loadedAt!)}`, `${fmtCount(s.matched)} of ${fmtCount(s.liveChannels)} channels matched`];
  if (s.days) parts.push(`${s.days} day${s.days > 1 ? 's' : ''}`);
  if (s.until && Date.now() > s.until) parts.push('listings ended — refresh');
  else if (s.until && s.until - Date.now() < 12 * 3600_000) parts.push('listings end soon — refresh');
  return parts.join(' · ');
}

/** "Downloading 34 MB…" / "Parsing 120k programmes…" plus a 0–1 fraction when known. */
export function guideProgressText(p: GuideState['progress']): { text: string; fraction?: number } {
  if (!p) return { text: '' };
  const src = p.sourceCount > 1 ? ` (${p.sourceIndex + 1}/${p.sourceCount})` : '';
  if (p.phase === 'save') return { text: `Saving ${fmtK(p.kept)} programmes…`, fraction: 1 };
  const fraction = p.total ? Math.min(1, p.bytes / p.total) : undefined;
  if (p.phase === 'download' && p.bytes === 0) return { text: `Connecting${src}…`, fraction: 0 };
  const dl = `${p.phase === 'download' ? 'Downloading' : 'Read'} ${fmtMB(p.bytes)}${p.total ? ` of ${fmtMB(p.total)}` : ''}`;
  return { text: `${dl} · Parsing ${fmtK(p.programmes)} programmes…${src}`, fraction };
}

// Diagnostics handle for the stream-lab benchmark (tests/streamlab/bigbench.mjs).
if (typeof window !== 'undefined') {
  (window as unknown as { __dialGuide?: unknown }).__dialGuide = {
    state: () => ({ ...useGuide.getState(), mode: guideDebug.mode, status: guideStatusText(useGuide.getState()), programsInMemory: useApp.getState().programs.length }),
  };
}

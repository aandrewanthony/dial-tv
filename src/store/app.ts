import { create } from 'zustand';
import type {
  BetPick, Channel, EpgSource, League, PlaylistSource, Program, ScheduleEntry, ScheduleRule, SportEvent,
} from '../types';
import { kv } from './db';
import { m3uUrlProvider, mapXmltvPrograms } from '../providers/remote';
import { parseM3U } from '../lib/m3u';
import { fetchText } from '../lib/net';
import { HOUR } from '../lib/scheduler';

export const SCHEMA_VERSION = 4;

export interface Settings {
  clutchAlerts: boolean;
  /** Switch the player automatically to a game that turns clutch (only when watching sports). */
  autoSwitch: boolean;
  notifications: boolean;
  /** Hide scores everywhere until a game is revealed. */
  spoilerShield: boolean;
  revealed: string[];
  density: 'comfortable' | 'compact';
  accent: string;
  guideZoom: 30 | 60 | 120;
  /** SHA-256 hex of the parental PIN. */
  lockPin?: string;
  locked: string[];
  /** Desktop built-in decoder: auto (when needed), always, or off. */
  decoder: 'auto' | 'always' | 'off';
  /** Channels that needed the decoder; they start with it next time. */
  decoderChannels: string[];
}

export interface FantasyConfig {
  provider: 'sleeper';
  username: string;
  userId: string;
  displayName: string;
  leagueId?: string;
  leagueName?: string;
}

export interface PersistedState {
  version: number;
  playlists: PlaylistSource[];
  epgSources: EpgSource[];
  favorites: string[];
  hidden: string[];
  channelOrder: string[];
  lastChannelId?: string;
  prevChannelId?: string;
  schedule: ScheduleEntry[];
  rules: ScheduleRule[];
  /** Rule-generated entries the user deleted, so rules don't re-add them. */
  dismissed: string[];
  favTeams: string[];
  leagues: League[];
  networkOverrides: Record<string, string>;
  /** playlist channel id → XMLTV channel id */
  epgManual: Record<string, string>;
  /** Guide URLs auto-discovered from playlists (url-tvg) that the user removed: never re-add them. */
  dismissedEpgUrls: string[];
  fantasy?: FantasyConfig;
  picks: BetPick[];
  pickPlayers: string[];
  settings: Settings;
}

export interface Toast {
  id: string;
  kind: 'info' | 'clutch' | 'reminder' | 'error' | 'redzone';
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
  ttl?: number;
}

interface RuntimeState {
  hydrated: boolean;
  channels: Channel[];
  programs: Program[];
  games: Record<string, SportEvent>;
  sportsUpdated?: number;
  sportsError?: string;
  loadingSources: boolean;
  currentId?: string;
  theater: boolean;
  multiview: (string | null)[];
  unlocked: boolean;
  toasts: Toast[];
  searchOpen: boolean;
  unmatchedEpg: { id: string; name: string }[];
  xmltvChannels: { id: string; name: string }[];
  /**
   * Set when saved data could not be read or written (IndexedDB failure / storage full).
   * While set because of a read failure, changes are kept in memory only and NOT saved,
   * so the real saved data is never overwritten with defaults.
   */
  storageError?: string;
}

export type AppState = PersistedState & RuntimeState & {
  set: (p: Partial<PersistedState & RuntimeState>) => void;
  update: (fn: (s: AppState) => Partial<PersistedState & RuntimeState>) => void;
  tune: (id: string) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  /**
   * Reload all enabled playlists and guides. Concurrent calls coalesce: while a load is
   * running, a call schedules one follow-up pass and resolves when that pass finishes.
   */
  loadSources: () => Promise<void>;
  /** Remove a playlist (and its stored file), then reload. */
  removePlaylist: (id: string) => Promise<void>;
  /** Remove a guide source (and its stored file), remember its URL so playlist auto-discovery won't re-add it, then reload. */
  removeEpgSource: (id: string) => Promise<void>;
};

export const DEFAULT_SETTINGS: Settings = {
  clutchAlerts: true,
  autoSwitch: false,
  notifications: false,
  spoilerShield: false,
  revealed: [],
  density: 'comfortable',
  accent: '#ff4d4d',
  guideZoom: 60,
  locked: [],
  decoder: 'auto',
  decoderChannels: [],
};

export function defaultPersisted(): PersistedState {
  return {
    version: SCHEMA_VERSION,
    playlists: [],
    epgSources: [],
    favorites: [],
    hidden: [],
    channelOrder: [],
    schedule: [],
    rules: [],
    dismissed: [],
    favTeams: [],
    leagues: ['nfl', 'ncaaf', 'nba', 'mlb', 'nhl'],
    networkOverrides: {},
    epgManual: {},
    dismissedEpgUrls: [],
    picks: [],
    pickPlayers: ['Me', 'Bro'],
    settings: DEFAULT_SETTINGS,
  };
}

/** Upgrade any older persisted shape to the current schema. */
export function migrate(raw: unknown): PersistedState {
  const base = defaultPersisted();
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Partial<PersistedState> & { version?: number };
  const v = s.version ?? 0;
  let out: PersistedState = { ...base, ...s, settings: { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) }, version: SCHEMA_VERSION };
  if (v < 2) {
    // v1 → v2: leagues list + pick players were introduced.
    out = { ...out, leagues: s.leagues?.length ? s.leagues : base.leagues, pickPlayers: s.pickPlayers?.length ? s.pickPlayers : base.pickPlayers };
  }
  if (v < 3) {
    // v2 → v3: no built-in channels. Drop the demo sources and the old free-channel presets.
    const builtIn = (x: { id: string; kind: string; url?: string }) =>
      x.kind === 'demo' || x.id === 'demo' || /iptv-org.github.io/.test(x.url ?? '');
    out = {
      ...out,
      playlists: out.playlists.filter((p) => !builtIn(p)),
      epgSources: out.epgSources.filter((e) => !builtIn(e)),
      favorites: out.favorites.filter((id) => !id.startsWith('demo:')),
      lastChannelId: out.lastChannelId?.startsWith('demo:') ? undefined : out.lastChannelId,
      prevChannelId: out.prevChannelId?.startsWith('demo:') ? undefined : out.prevChannelId,
    } as PersistedState;
  }
  if (v < 4 || !Array.isArray(out.dismissedEpgUrls)) {
    // v3 → v4: remembered dismissals of auto-discovered guides.
    out = { ...out, dismissedEpgUrls: Array.isArray(s.dismissedEpgUrls) ? s.dismissedEpgUrls : [] };
  }
  return out;
}

/** v0.1 stored scheduled demo programs in localStorage with ISO dates. */
function legacySchedule(): ScheduleEntry[] {
  try {
    const raw = localStorage.getItem('dial-schedule');
    if (!raw) return [];
    const arr = JSON.parse(raw) as { id: string; title: string; start: string; end: string; channelId?: string }[];
    return arr
      .map((p) => ({ id: `legacy:${p.id}`, title: p.title, start: Date.parse(p.start), end: Date.parse(p.end), channelId: undefined }))
      .filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end));
  } catch {
    return [];
  }
}

const PERSIST_KEYS: (keyof PersistedState)[] = Object.keys(defaultPersisted()) as (keyof PersistedState)[];

/** Guide window kept in memory: 12h back, 7 days ahead. */
export const EPG_BACK = 12 * HOUR;
export const EPG_AHEAD = 7 * 24 * HOUR;

let toastSeq = 0;

/**
 * Channel numbers must be unique across playlists. Keep the first channel with a number,
 * move later duplicates to the next free number. Deterministic for the same input order.
 */
export function dedupeChannelNumbers(channels: Channel[]): Channel[] {
  const used = new Set(channels.map((c) => c.number));
  const seen = new Set<number>();
  let changed = false;
  const out = channels.map((c) => {
    if (!seen.has(c.number)) {
      seen.add(c.number);
      return c;
    }
    let n = c.number + 1;
    while (used.has(n)) n++;
    used.add(n);
    seen.add(n);
    changed = true;
    return { ...c, number: n };
  });
  return changed ? out : channels;
}

type PlaylistMeta = Pick<PlaylistSource, 'lastLoaded' | 'channelCount' | 'error'>;
type EpgMeta = Pick<EpgSource, 'lastLoaded' | 'programCount' | 'error'>;

/** Merge per-source load results into the CURRENT source list; removed sources are never re-added. */
function mergeMeta<T extends { id: string }, M>(list: T[], meta: Map<string, M>): T[] {
  if (!meta.size || !list.some((x) => meta.has(x.id))) return list;
  return list.map((x) => (meta.has(x.id) ? { ...x, ...meta.get(x.id) } : x));
}

let loadInFlight: Promise<void> | null = null;
let loadDirty = false;

export const useApp = create<AppState>((set, get) => {
  /** One full pass over the sources. All writes merge into current state, never stale snapshots. */
  async function loadOnce() {
    const results = new Map<string, Channel[]>();
    const plMeta = new Map<string, PlaylistMeta>();
    let numberStart = 200;

    for (const src of get().playlists.filter((p) => p.enabled)) {
      try {
        let loaded: Channel[] = [];
        let epgUrl: string | undefined;
        if (src.kind === 'm3u-file') {
          const text = await kv.get<string>(`file:${src.id}`);
          loaded = text ? parseM3U(text, src.id, numberStart).channels : [];
        } else {
          const r = await m3uUrlProvider(src, numberStart).load();
          loaded = r.channels;
          epgUrl = r.epgUrl;
        }
        results.set(src.id, loaded);
        numberStart += Math.ceil((loaded.length + 1) / 100) * 100;
        plMeta.set(src.id, { lastLoaded: Date.now(), channelCount: loaded.length, error: undefined });
        if (epgUrl) discoverEpg(src, epgUrl);
      } catch (e) {
        plMeta.set(src.id, { error: (e as Error).message });
      }
    }

    // Channels from the playlists that are enabled *now*, in the current playlist order.
    const channelsNow = () =>
      dedupeChannelNumbers(get().playlists.filter((p) => p.enabled).flatMap((p) => results.get(p.id) ?? []));
    const mapChannels = channelsNow();

    const programs: Program[] = [];
    const epgMeta = new Map<string, EpgMeta>();
    let unmatched: { id: string; name: string }[] = [];
    let xmltvChannels: { id: string; name: string }[] = [];
    for (const src of get().epgSources.filter((e) => e.enabled)) {
      try {
        let loaded: Program[] = [];
        const text = src.kind === 'xmltv-file' ? await kv.get<string>(`file:${src.id}`) : await fetchText(src.url!);
        if (text) {
          const now = Date.now();
          const r = mapXmltvPrograms(text, mapChannels, get().epgManual, { from: now - EPG_BACK, to: now + EPG_AHEAD });
          loaded = r.programs;
          unmatched = unmatched.concat(r.unmatched);
          xmltvChannels = xmltvChannels.concat(r.xmltvChannels);
        }
        for (const p of loaded) programs.push(p);
        epgMeta.set(src.id, { lastLoaded: Date.now(), programCount: loaded.length, error: undefined });
      } catch (e) {
        epgMeta.set(src.id, { error: (e as Error).message });
      }
    }

    // Sources may have been toggled/removed while we were awaiting: only keep data for what is enabled now.
    const channels = channelsNow();
    const chIds = new Set(channels.map((c) => c.id));
    const enabledEpg = new Set(get().epgSources.filter((e) => e.enabled).map((e) => e.id));
    const keptPrograms = enabledEpg.size ? programs.filter((p) => chIds.has(p.channelId)) : [];
    set((s) => ({
      channels,
      programs: keptPrograms,
      playlists: mergeMeta(s.playlists, plMeta),
      epgSources: mergeMeta(s.epgSources, epgMeta),
      unmatchedEpg: unmatched,
      xmltvChannels,
      currentId:
        s.currentId && chIds.has(s.currentId) ? s.currentId : channels.find((c) => c.id === s.lastChannelId)?.id ?? channels[0]?.id,
    }));
    void kv.set('cache:channels', channels);
  }

  /** Add (or update by id) the guide a playlist advertises via url-tvg, unless the user dismissed it. */
  function discoverEpg(src: PlaylistSource, epgUrl: string) {
    set((s) => {
      if (!s.playlists.some((p) => p.id === src.id)) return {};
      if (s.dismissedEpgUrls.includes(epgUrl) || s.epgSources.some((e) => e.url === epgUrl)) return {};
      const id = `epg-${src.id}`;
      if (s.epgSources.some((e) => e.id === id)) {
        return { epgSources: s.epgSources.map((e) => (e.id === id ? { ...e, url: epgUrl, error: undefined } : e)) };
      }
      const add: EpgSource = { id, name: `${src.name} guide`, kind: 'xmltv-url', url: epgUrl, enabled: true };
      return { epgSources: [...s.epgSources, add] };
    });
  }

  return {
    ...defaultPersisted(),
    hydrated: false,
    channels: [],
    programs: [],
    games: {},
    loadingSources: false,
    theater: false,
    multiview: [null, null, null, null],
    unlocked: false,
    toasts: [],
    searchOpen: false,
    unmatchedEpg: [],
    xmltvChannels: [],

    set: (p) => set(p),
    update: (fn) => set((s) => fn(s)),

    tune: (id) => {
      const s = get();
      if (id === s.currentId) return;
      set({ currentId: id, prevChannelId: s.currentId ?? s.prevChannelId, lastChannelId: id });
    },

    toast: (t) => {
      const id = `t${++toastSeq}`;
      set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
      const ttl = t.ttl ?? (t.kind === 'clutch' || t.kind === 'reminder' ? 20000 : 6000);
      if (ttl > 0) setTimeout(() => get().dismissToast(id), ttl);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    loadSources: () => {
      if (loadInFlight) {
        // Coalesce: run one more pass after the current one so changes made meanwhile are picked up.
        loadDirty = true;
        return loadInFlight;
      }
      set({ loadingSources: true });
      loadInFlight = (async () => {
        try {
          do {
            loadDirty = false;
            await loadOnce();
          } while (loadDirty);
        } finally {
          loadInFlight = null;
          set({ loadingSources: false });
        }
      })();
      return loadInFlight;
    },

    removePlaylist: async (id) => {
      set((s) => ({ playlists: s.playlists.filter((p) => p.id !== id) }));
      await kv.del(`file:${id}`);
      await get().loadSources();
    },

    removeEpgSource: async (id) => {
      set((s) => {
        const src = s.epgSources.find((e) => e.id === id);
        const url = src?.kind === 'xmltv-url' ? src.url : undefined;
        return {
          epgSources: s.epgSources.filter((e) => e.id !== id),
          dismissedEpgUrls: url && !s.dismissedEpgUrls.includes(url) ? [...s.dismissedEpgUrls, url] : s.dismissedEpgUrls,
        };
      });
      await kv.del(`file:${id}`);
      await get().loadSources();
    },
  };
});

let resetting = false;

/** Wipe all saved data (settings, schedule, picks, caches) and restart fresh. */
export async function resetAllData() {
  resetting = true;
  await kv.clear();
  location.reload();
}

export const STORAGE_READ_ERROR =
  'Could not read your saved data. Changes this session will not be saved. Restart the app to try again.';
export const STORAGE_WRITE_ERROR =
  'Could not save your changes (storage full or unavailable). They are kept until you close the app.';

let unsubscribeSave: (() => void) | null = null;
let pagehideFlush: (() => void) | null = null;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Load persisted state, start auto-saving, then load sources. */
export async function hydrate() {
  let stored: PersistedState | undefined;
  let readFailed = false;
  for (let attempt = 0; ; attempt++) {
    try {
      stored = await kv.get<PersistedState>('state');
      break;
    } catch {
      if (attempt >= 1) {
        readFailed = true;
        break;
      }
      await delay(250);
    }
  }
  if (!stored && !readFailed) {
    // Older builds fell back to localStorage when IndexedDB writes failed: adopt that copy once.
    try {
      const raw = localStorage.getItem('dial-tv:state');
      if (raw) stored = JSON.parse(raw) as PersistedState;
    } catch {
      /* ignore */
    }
  }
  const state = migrate(stored);
  if (!stored && !readFailed) state.schedule = legacySchedule();
  const cachedChannels = await kv.get<Channel[]>('cache:channels').catch(() => undefined);
  useApp.setState({
    ...state,
    hydrated: true,
    channels: (cachedChannels ?? []).filter((c) => c.sourceId !== 'demo'),
    currentId: state.lastChannelId,
    storageError: readFailed ? STORAGE_READ_ERROR : undefined,
  });

  unsubscribeSave?.();
  unsubscribeSave = null;
  if (pagehideFlush) window.removeEventListener('pagehide', pagehideFlush);
  pagehideFlush = null;

  if (readFailed) {
    // Never auto-save over data we failed to read: run in memory only.
    useApp.getState().toast({ kind: 'error', title: 'Saved data unavailable', body: STORAGE_READ_ERROR, ttl: 0 });
  } else {
    // Coalesce bursts of updates into one write per tick, and flush when the page is hidden/closed,
    // so nothing is lost if the window closes right after an action.
    let pending = false;
    const flush = () => {
      pending = false;
      if (resetting) return;
      void kv.put('state', pickPersisted(useApp.getState())).then(
        () => {
          if (useApp.getState().storageError === STORAGE_WRITE_ERROR) useApp.setState({ storageError: undefined });
        },
        () => {
          // No localStorage fallback: a stale copy there would shadow IndexedDB later.
          if (useApp.getState().storageError !== STORAGE_WRITE_ERROR) useApp.setState({ storageError: STORAGE_WRITE_ERROR });
        },
      );
    };
    unsubscribeSave = useApp.subscribe((s, prev) => {
      if (PERSIST_KEYS.every((k) => s[k] === prev[k]) || pending) return;
      pending = true;
      queueMicrotask(flush);
    });
    pagehideFlush = flush;
    window.addEventListener('pagehide', flush);
  }

  await useApp.getState().loadSources();
}

export function pickPersisted(s: AppState): PersistedState {
  const out = {} as Record<string, unknown>;
  for (const k of PERSIST_KEYS) out[k] = s[k];
  return out as unknown as PersistedState;
}

// ---------- selectors / helpers ----------

export function orderedChannels(s: Pick<AppState, 'channels' | 'channelOrder' | 'hidden'>, includeHidden = false) {
  const idx = new Map(s.channelOrder.map((id, i) => [id, i]));
  const hidden = includeHidden ? null : new Set(s.hidden);
  return s.channels
    .filter((c) => !hidden || !hidden.has(c.id))
    .sort((a, b) => (idx.get(a.id) ?? 1e6 + a.number) - (idx.get(b.id) ?? 1e6 + b.number));
}

const programIndex = new WeakMap<Program[], Map<string, Program[]>>();

/**
 * Programs grouped by channel id, each list sorted by start. Memoized per programs array
 * (the store replaces the array on every load), so it is cheap to call during render.
 */
export function programsByChannel(programs: Program[]): Map<string, Program[]> {
  let m = programIndex.get(programs);
  if (!m) {
    m = new Map();
    for (const p of programs) {
      const arr = m.get(p.channelId);
      if (arr) arr.push(p);
      else m.set(p.channelId, [p]);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.start - b.start);
    programIndex.set(programs, m);
  }
  return m;
}

/** Index of the last program with start <= at (binary search), or -1. */
function lastStartingAtOrBefore(arr: Program[], at: number) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].start <= at) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Programs of one channel overlapping [from, to), sorted by start. */
export function programsInRange(programs: Program[], channelId: string, from: number, to: number): Program[] {
  const arr = programsByChannel(programs).get(channelId);
  if (!arr) return [];
  const out: Program[] = [];
  // Programs are short (< 12h after parsing), so start a little before `from`.
  let i = lastStartingAtOrBefore(arr, from - 12 * HOUR) + 1;
  for (; i < arr.length && arr[i].start < to; i++) if (arr[i].end > from) out.push(arr[i]);
  return out;
}

export function nowPlaying(programs: Program[], channelId: string, at = Date.now()) {
  const arr = programsByChannel(programs).get(channelId);
  if (!arr) return undefined;
  const last = lastStartingAtOrBefore(arr, at);
  // Overlaps are rare: check the last few programs that started before `at`.
  for (let i = last; i >= 0 && i >= last - 3; i--) if (arr[i].end > at) return arr[i];
  return undefined;
}

/** The next program to start after `at` on a channel. */
export function upNext(programs: Program[], channelId: string, at = Date.now()) {
  const arr = programsByChannel(programs).get(channelId);
  return arr ? arr[lastStartingAtOrBefore(arr, at) + 1] : undefined;
}

/** Store selector: the tuned channel object (or undefined). */
export const selectCurrentChannel = (s: Pick<AppState, 'channels' | 'currentId'>) =>
  s.currentId ? s.channels.find((c) => c.id === s.currentId) : undefined;

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function showScore(s: Pick<AppState, 'settings'>, eventId: string) {
  return !s.settings.spoilerShield || s.settings.revealed.includes(eventId);
}

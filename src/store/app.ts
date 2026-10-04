import { create } from 'zustand';
import type {
  Channel, EpgSource, League, PlaylistSource, Program, ScheduleEntry, ScheduleRule, SportEvent,
} from '../types';
import { kv } from './db';
import { m3uUrlProvider } from '../providers/remote';
import { parseM3U } from '../lib/m3u';
import { HOUR } from '../lib/scheduler';
import { applyPrefs, localeCountry, organize, orderGroups, type GroupInfo, type OrgChannel, type Organized } from '../lib/channelOrg';
import { useChannelPrefs, type ChannelPrefs } from './channelPrefs';

export const SCHEMA_VERSION = 5;

export interface Settings {
  clutchAlerts: boolean;
  /** Switch the player automatically to a game that turns clutch (only when watching sports). */
  autoSwitch: boolean;
  notifications: boolean;
  /** Hide scores everywhere until a game is revealed. */
  spoilerShield: boolean;
  revealed: string[];
  density: 'comfortable' | 'compact';
  /** Dark, light, or follow the operating system. */
  theme: 'dark' | 'light' | 'system';
  accent: string;
  guideZoom: 30 | 60 | 120;
  /** SHA-256 hex of the parental PIN. */
  lockPin?: string;
  locked: string[];
  /** Desktop built-in decoder: auto (when needed), always, or off. */
  decoder: 'auto' | 'always' | 'off';
  /** Channels that needed the decoder; they start with it next time. */
  decoderChannels: string[];
  /** Settings → Playback (buffering, computer performance, quality). */
  playback: PlaybackSettings;
}

/** Playback tuning. "auto" values are resolved by the player from the machine (see player/tuning.ts). */
export interface PlaybackSettings {
  /** How much video to buffer ahead: smaller = closer to live, bigger = fewer stalls. */
  buffer: 'auto' | 'low-latency' | 'balanced' | 'smooth' | 'max';
  /** This computer's power: sets decoder speed/quality and how many streams Multiview runs. */
  computer: 'auto' | 'low' | 'medium' | 'high';
  /** Use the graphics card to convert video in the built-in decoder (NVIDIA / Intel / AMD / Apple). */
  hwAccel: 'auto' | 'on' | 'off';
  /** Cap the resolution the player picks or the decoder outputs. */
  maxResolution: 'auto' | '2160' | '1080' | '720' | '480';
  /** Start adaptive streams at: auto (bandwidth estimate), highest, or lowest quality. */
  startQuality: 'auto' | 'highest' | 'lowest';
  deinterlace: 'auto' | 'on' | 'off';
  /** Remember where you stopped in movies/episodes. */
  resumeVod: boolean;
}

export const DEFAULT_PLAYBACK: PlaybackSettings = {
  buffer: 'auto',
  computer: 'auto',
  hwAccel: 'auto',
  maxResolution: 'auto',
  startQuality: 'auto',
  deinterlace: 'auto',
  resumeVod: true,
};

/** Fantasy platforms. Phase 2 seam: a Dial TV-hosted league would be another provider id here (see store/fantasy.ts). */
export type FantasyPlatform = 'sleeper' | 'espn';

/**
 * Connected fantasy league. Sleeper: username → userId. ESPN: public league id; `userId` holds the chosen
 * ESPN team id and `displayName` that team's name.
 */
export interface FantasyConfig {
  provider: FantasyPlatform;
  username: string;
  userId: string;
  displayName: string;
  leagueId?: string;
  leagueName?: string;
  /** ESPN: league season (year). */
  season?: string;
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
  /** First-run sports onboarding finished or skipped. */
  sportsOnboarded: boolean;
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
   * Re-download enabled playlists (all, or `only` these — the others keep their loaded channels).
   * Guides are not downloaded here (store/guide.ts#loadGuide). Concurrent calls coalesce: while a
   * load is running, a call schedules one follow-up pass and resolves when that pass finishes.
   */
  loadSources: (opts?: { only?: string[] }) => Promise<void>;
  /** Remove a playlist (and its stored file), then rebuild channels without re-downloading. */
  removePlaylist: (id: string) => Promise<void>;
  /** Remove a guide source (and its stored file), remember its URL so playlist auto-discovery won't re-add it. */
  removeEpgSource: (id: string) => Promise<void>;
};

export const DEFAULT_SETTINGS: Settings = {
  clutchAlerts: true,
  autoSwitch: false,
  notifications: false,
  spoilerShield: false,
  revealed: [],
  density: 'comfortable',
  theme: 'dark',
  accent: '#ff4d4d',
  guideZoom: 60,
  locked: [],
  decoder: 'auto',
  decoderChannels: [],
  playback: DEFAULT_PLAYBACK,
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
    sportsOnboarded: false,
    settings: DEFAULT_SETTINGS,
  };
}

/** Upgrade any older persisted shape to the current schema. */
export function migrate(raw: unknown): PersistedState {
  const base = defaultPersisted();
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Partial<PersistedState> & { version?: number };
  const v = s.version ?? 0;
  let out: PersistedState = { ...base, ...s, settings: { ...DEFAULT_SETTINGS, ...(s.settings ?? {}), playback: { ...DEFAULT_PLAYBACK, ...(s.settings?.playback ?? {}) } }, version: SCHEMA_VERSION };
  if (v < 2) {
    // v1 → v2: leagues list + pick players were introduced.
    out = { ...out, leagues: s.leagues?.length ? s.leagues : base.leagues };
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
  if (v < 5) {
    // v4 → v5: the "Me vs Bro" pick'em was removed (real bets live in the Bets feature store).
    // Users who already picked teams have effectively been onboarded.
    const legacy = out as PersistedState & { picks?: unknown; pickPlayers?: unknown };
    delete legacy.picks;
    delete legacy.pickPlayers;
    out = { ...legacy, sportsOnboarded: s.sportsOnboarded ?? out.favTeams.length > 0 };
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

/** Guide window bounds: listings are kept from 6h back to at most 7 days ahead (store/guide.ts, Settings → days). */
export const EPG_BACK = 6 * HOUR;
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

/** Merge per-source load results into the CURRENT source list; removed sources are never re-added. */
function mergeMeta<T extends { id: string }, M>(list: T[], meta: Map<string, M>): T[] {
  if (!meta.size || !list.some((x) => meta.has(x.id))) return list;
  return list.map((x) => (meta.has(x.id) ? { ...x, ...meta.get(x.id) } : x));
}

let loadInFlight: Promise<void> | null = null;
let loadDirty = false;
/** Follow-up pass request: undefined = none, null = all playlists, Set = only these (union of calls). */
let pendingOnly: Set<string> | null | undefined;

export const useApp = create<AppState>((set, get) => {
  /**
   * One pass over the playlists. All writes merge into current state, never stale snapshots.
   * `only`: re-download just these playlists and reuse the channels already loaded for the others
   * (null = re-download all). Guides are NOT downloaded here: see store/guide.ts (manual "Load guide").
   */
  async function loadOnce(only: Set<string> | null) {
    const results = new Map<string, Channel[]>();
    const plMeta = new Map<string, PlaylistMeta>();
    let numberStart = 200;
    const have = new Map<string, Channel[]>();
    if (only) for (const c of get().channels) {
      const arr = have.get(c.sourceId);
      if (arr) arr.push(c);
      else have.set(c.sourceId, [c]);
    }

    for (const src of get().playlists.filter((p) => p.enabled)) {
      const reuse = only && !only.has(src.id) ? have.get(src.id) : undefined;
      if (reuse) {
        results.set(src.id, reuse);
        numberStart += Math.ceil((reuse.length + 1) / 100) * 100;
        continue;
      }
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

    // Sources may have been toggled/removed while we were awaiting: only keep data for what is enabled now.
    // The guide store re-maps its cached listings onto the new channels (no download).
    const channels = channelsNow();
    const chIds = new Set(channels.map((c) => c.id));
    set((s) => ({
      channels,
      playlists: mergeMeta(s.playlists, plMeta),
      currentId:
        s.currentId && chIds.has(s.currentId) ? s.currentId : channels.find((c) => c.id === s.lastChannelId)?.id ?? (channels.find((c) => !c.kind || c.kind === 'live') ?? channels[0])?.id,
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

    loadSources: (opts) => {
      const req = opts?.only ? new Set(opts.only) : null;
      if (loadInFlight) {
        // Coalesce: run one more pass after the current one so changes made meanwhile are picked up.
        loadDirty = true;
        pendingOnly = pendingOnly === undefined ? req : pendingOnly === null || req === null ? null : new Set([...pendingOnly, ...req]);
        return loadInFlight;
      }
      set({ loadingSources: true });
      loadInFlight = (async () => {
        try {
          let only = req;
          for (;;) {
            loadDirty = false;
            pendingOnly = undefined;
            await loadOnce(only);
            if (!loadDirty) break;
            only = pendingOnly ?? null;
          }
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
      // Rebuild from the playlists already loaded: nothing is re-downloaded.
      await get().loadSources({ only: [] });
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
      // The guide store drops that source's cached listings (no downloads).
      await kv.del(`file:${id}`);
    },
  };
});

let resetting = false;

/** Wipe all saved data (settings, schedule, caches) and restart fresh. */
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

  // Startup uses cached data only. Playlists are downloaded only when there is no cached copy
  // (first run, or a playlist that never loaded); "Refresh playlists" / the daily policy re-download.
  // The guide comes from its own cache and is downloaded only on request (store/guide.ts).
  const s = useApp.getState();
  const loadedSources = new Set(s.channels.map((c) => c.sourceId));
  const missing = s.playlists.filter((p) => p.enabled && (!cachedChannels || (!loadedSources.has(p.id) && !p.lastLoaded)));
  await Promise.all([
    missing.length ? s.loadSources({ only: missing.map((p) => p.id) }) : undefined,
    import('./guide').then((g) => g.initGuide()).catch(() => undefined),
  ]);
}

export function pickPersisted(s: AppState): PersistedState {
  const out = {} as Record<string, unknown>;
  for (const k of PERSIST_KEYS) out[k] = s[k];
  return out as unknown as PersistedState;
}

// ---------- selectors / helpers ----------

export const isLive = (c: Channel) => !c.kind || c.kind === 'live';

type ChannelSel = Pick<AppState, 'channels' | 'channelOrder' | 'hidden'> & { settings?: Pick<Settings, 'playback'> };

let homeCountry: string | undefined;

/**
 * Organized live channels (all, including hidden): clean names, duplicates merged into one
 * logical channel per real channel (Settings → Channels → Merge duplicates), country + category
 * groups. Memoized per channels array, so it's cheap during render.
 */
export function organizedChannels(s: ChannelSel, prefs: ChannelPrefs = useChannelPrefs.getState()): Organized {
  const maxRes = (s.settings ?? useApp.getState().settings).playback?.maxResolution ?? 'auto';
  homeCountry ??= localeCountry();
  return organize(s.channels, { merge: prefs.mergeDuplicates, maxRes, homeCountry });
}

const appliedCache = new Map<boolean, { deps: unknown[]; out: OrgChannel[] }>();

/**
 * Live TV channels in the user's order (movies and series episodes are excluded: see vodItems):
 * merged logical channels with display names, visible groups only (unless includeHidden),
 * groups in the user's order, then the custom channel order / channel number inside each group.
 * A logical channel keeps its id entry's id and tvg-id, so guide listings still resolve.
 */
export function orderedChannels(s: ChannelSel, includeHidden = false, prefs: ChannelPrefs = useChannelPrefs.getState()): OrgChannel[] {
  const org = organizedChannels(s, prefs);
  const deps = [org, s.channelOrder, s.hidden, prefs.hiddenGroups, prefs.groupOrder, prefs.groupNames, prefs.variantChoice, prefs.renumber];
  const hit = appliedCache.get(includeHidden);
  if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) return hit.out;
  const out = applyPrefs(org, prefs, { channelOrder: s.channelOrder, hidden: s.hidden, includeHidden });
  appliedCache.set(includeHidden, { deps, out });
  return out;
}

/** Channel groups in the user's order, with labels (renames applied), counts and hidden flags. */
export function channelGroups(s: ChannelSel, prefs: ChannelPrefs = useChannelPrefs.getState()): (GroupInfo & { hidden: boolean; defaultLabel: string })[] {
  const org = organizedChannels(s, prefs);
  const hidden = new Set(prefs.hiddenGroups);
  return orderGroups(org, prefs).map((g) => ({ ...g, defaultLabel: g.label, label: prefs.groupNames[g.key] || g.label, hidden: hidden.has(g.key) }));
}

/** Logical channel id for any playlist entry id (a merged "ESPN 4K" entry → its "ESPN" channel). */
export function resolveChannelId(s: ChannelSel, id: string | undefined): string | undefined {
  if (!id) return id;
  return organizedChannels(s).alias.get(id) ?? id;
}

/**
 * Locked channel ids, expanded so a lock saved on any merged duplicate (e.g. "US| ESPN FHD")
 * also locks the logical channel it was merged into (and the other way round).
 */
const lockCache = new WeakMap<string[], { org: unknown; set: Set<string> }>();
export function lockedSet(s: ChannelSel & { settings: Settings }): Set<string> {
  const org = organizedChannels(s);
  const hit = lockCache.get(s.settings.locked);
  if (hit && hit.org === org) return hit.set;
  const out = new Set<string>();
  lockCache.set(s.settings.locked, { org, set: out });
  for (const id of s.settings.locked) {
    out.add(id);
    const logical = org.alias.get(id) ?? id;
    out.add(logical);
  }
  return out;
}

const vodCache = new WeakMap<Channel[], { movies: Channel[]; episodes: Channel[] }>();
/** Movies and series episodes from all playlists (cached per channels array). */
export function vodItems(channels: Channel[]) {
  let v = vodCache.get(channels);
  if (!v) {
    v = { movies: channels.filter((c) => c.kind === 'movie'), episodes: channels.filter((c) => c.kind === 'series') };
    vodCache.set(channels, v);
  }
  return v;
}

const programIndex = new WeakMap<Program[], Map<string, Program[]>>();

/**
 * The guide store registers a ready-made index for the programs array it publishes: guide
 * listings are stored once per guide channel and shared by every playlist channel that maps to
 * it, so the index has an entry (the same sorted list) for each of those playlist channel ids.
 */
export function registerProgramIndex(programs: Program[], index: Map<string, Program[]>) {
  programIndex.set(programs, index);
}

/**
 * Programs grouped by playlist channel id, each list sorted by start. Memoized per programs array
 * (the store replaces the array on every change), so it is cheap to call during render.
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

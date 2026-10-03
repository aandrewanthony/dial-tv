import { create } from 'zustand';
import type {
  BetPick, Channel, EpgSource, League, PlaylistSource, Program, ScheduleEntry, ScheduleRule, SportEvent,
} from '../types';
import { kv } from './db';
import { m3uUrlProvider, mapXmltvPrograms } from '../providers/remote';
import { parseM3U } from '../lib/m3u';
import { fetchText } from '../lib/net';
import { HOUR } from '../lib/scheduler';

export const SCHEMA_VERSION = 3;

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
}

export type AppState = PersistedState & RuntimeState & {
  set: (p: Partial<PersistedState & RuntimeState>) => void;
  update: (fn: (s: AppState) => Partial<PersistedState & RuntimeState>) => void;
  tune: (id: string) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  loadSources: () => Promise<void>;
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

let toastSeq = 0;

export const useApp = create<AppState>((set, get) => ({
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

  loadSources: async () => {
    if (get().loadingSources) return;
    set({ loadingSources: true });
    const s = get();
    const channels: Channel[] = [];
    const playlists = [...s.playlists];
    const epgSources = [...s.epgSources];
    let numberStart = 200;

    for (let i = 0; i < playlists.length; i++) {
      const src = playlists[i];
      if (!src.enabled) continue;
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
        if (epgUrl && !epgSources.some((e) => e.url === epgUrl)) {
          epgSources.push({ id: `epg-${src.id}`, name: `${src.name} guide`, kind: 'xmltv-url', url: epgUrl, enabled: true });
        }
        channels.push(...loaded);
        numberStart += Math.ceil((loaded.length + 1) / 100) * 100;
        playlists[i] = { ...src, lastLoaded: Date.now(), channelCount: loaded.length, error: undefined };
      } catch (e) {
        playlists[i] = { ...src, error: (e as Error).message };
      }
    }

    const programs: Program[] = [];
    let unmatched: { id: string; name: string }[] = [];
    let xmltvChannels: { id: string; name: string }[] = [];
    for (let i = 0; i < epgSources.length; i++) {
      const src = epgSources[i];
      if (!src.enabled) continue;
      try {
        let loaded: Program[] = [];
        {
          const text = src.kind === 'xmltv-file' ? await kv.get<string>(`file:${src.id}`) : await fetchText(src.url!);
          if (text) {
            const r = mapXmltvPrograms(text, channels, s.epgManual);
            loaded = r.programs;
            unmatched = unmatched.concat(r.unmatched);
            xmltvChannels = xmltvChannels.concat(r.xmltvChannels);
          }
        }
        // Keep a rolling window to bound memory: 12h back, 7 days ahead.
        const lo = Date.now() - 12 * HOUR;
        const hi = Date.now() + 7 * 24 * HOUR;
        loaded = loaded.filter((p) => p.end > lo && p.start < hi);
        programs.push(...loaded);
        epgSources[i] = { ...src, lastLoaded: Date.now(), programCount: loaded.length, error: undefined };
      } catch (e) {
        epgSources[i] = { ...src, error: (e as Error).message };
      }
    }

    const cur = get().currentId;
    set({
      channels,
      programs,
      playlists,
      epgSources,
      unmatchedEpg: unmatched,
      xmltvChannels,
      loadingSources: false,
      currentId: cur && channels.some((c) => c.id === cur) ? cur : channels.find((c) => c.id === get().lastChannelId)?.id ?? channels[0]?.id,
    });
    void kv.set('cache:channels', channels);
  },
}));

let resetting = false;

/** Wipe all saved data (settings, schedule, picks, caches) and restart fresh. */
export async function resetAllData() {
  resetting = true;
  await kv.clear();
  location.reload();
}

/** Load persisted state, start auto-saving, then load sources. */
export async function hydrate() {
  const stored = await kv.get<PersistedState>('state');
  const state = migrate(stored);
  if (!stored) state.schedule = legacySchedule();
  const cachedChannels = await kv.get<Channel[]>('cache:channels');
  useApp.setState({
    ...state,
    hydrated: true,
    channels: (cachedChannels ?? []).filter((c) => c.sourceId !== 'demo'),
    currentId: state.lastChannelId,
  });

  // Coalesce bursts of updates into one write per tick, and flush when the page is hidden/closed,
  // so nothing is lost if the window closes right after an action.
  let pending = false;
  const flush = () => {
    pending = false;
    if (resetting) return;
    void kv.set('state', pickPersisted(useApp.getState()));
  };
  useApp.subscribe((s, prev) => {
    if (PERSIST_KEYS.every((k) => s[k] === prev[k]) || pending) return;
    pending = true;
    queueMicrotask(flush);
  });
  window.addEventListener('pagehide', flush);

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
  return s.channels
    .filter((c) => includeHidden || !s.hidden.includes(c.id))
    .sort((a, b) => (idx.get(a.id) ?? 1e6 + a.number) - (idx.get(b.id) ?? 1e6 + b.number));
}

export function nowPlaying(programs: Program[], channelId: string, at = Date.now()) {
  return programs.find((p) => p.channelId === channelId && p.start <= at && p.end > at);
}

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function showScore(s: Pick<AppState, 'settings'>, eventId: string) {
  return !s.settings.spoilerShield || s.settings.revealed.includes(eventId);
}

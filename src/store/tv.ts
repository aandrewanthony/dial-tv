import { createPersisted } from './persisted';
import {
  advance, editChannel, MIN_DURATION_SEC, nextNumber, rebase, type PersonalChannel, type PersonalItem,
} from '../lib/personalSchedule';

/** Resume point of a movie/episode (keyed by playlist channel id). */
export interface VodProgress {
  /** Seconds watched. */
  pos: number;
  /** Seconds total (0 = unknown). */
  dur: number;
  /** Last update, epoch ms. */
  at: number;
  watched?: boolean;
}

export interface TvData {
  progress: Record<string, VodProgress>;
  /** Measured durations in seconds (feeds My Channels scheduling). */
  durations: Record<string, number>;
  /** VOD ids or `show:<name>` keys. */
  favorites: string[];
  watchlist: string[];
  personal: PersonalChannel[];
}

export const WATCHED_AT = 0.92;
export const PERSONAL_PREFIX = 'my:';
export const PERSONAL_GROUP = 'My Channels';

export const useTv = createPersisted<TvData>({
  key: 'tv',
  version: 1,
  defaults: () => ({ progress: {}, durations: {}, favorites: [], watchlist: [], personal: [] }),
});

export const isPersonalId = (id?: string) => !!id && id.startsWith(PERSONAL_PREFIX);
export const personalIdOf = (channelId: string) => channelId.slice(PERSONAL_PREFIX.length);

// ---------- progress / durations ----------

/**
 * Record playback position. Writes are throttled (every ~5 s of movement) so frequent
 * timeupdate events don't hammer IndexedDB. Marks watched past 92 %.
 */
export function saveProgress(id: string, pos: number, dur: number) {
  if (!Number.isFinite(pos) || pos < 0) return;
  const d = Number.isFinite(dur) && dur > 0 ? dur : 0;
  const prev = useTv.getState().progress[id];
  const watched = d > 0 && pos / d >= WATCHED_AT;
  if (prev && Math.abs(prev.pos - pos) < 5 && !!prev.watched === watched && prev.dur === d) return;
  useTv.setState((s) => ({ progress: { ...s.progress, [id]: { pos, dur: d, at: Date.now(), watched: watched || undefined } } }));
  if (d) learnDuration(id, d);
}

export function markWatched(id: string, watched: boolean) {
  useTv.setState((s) => {
    const p = s.progress[id];
    if (!watched) {
      const { [id]: _drop, ...rest } = s.progress;
      return { progress: rest };
    }
    return { progress: { ...s.progress, [id]: { pos: p?.dur ?? 0, dur: p?.dur ?? 0, at: Date.now(), watched: true } } };
  });
}

/** Resume position (seconds) if partly watched and not finished. */
export function resumeAt(id: string): number | undefined {
  const p = useTv.getState().progress[id];
  if (!p || p.watched || p.pos < 30) return undefined;
  return p.pos;
}

/**
 * A real duration was measured. Personal channels that contain the item are rebased first
 * (with the OLD durations) so the item on air now keeps playing; the corrected duration then
 * moves only what comes after it.
 */
export function learnDuration(id: string, dur: number) {
  if (!Number.isFinite(dur) || dur < MIN_DURATION_SEC) return;
  const s = useTv.getState();
  const old = s.durations[id];
  if (old && Math.abs(old - dur) < 2) return;
  const now = Date.now();
  const personal = s.personal.map((c) => (c.items.some((x) => x.id === id) ? { ...c, anchor: rebase(c, s.durations, now) } : c));
  useTv.setState({ personal, durations: { ...s.durations, [id]: Math.round(dur) } });
}

export function toggleIn(list: 'favorites' | 'watchlist', key: string) {
  useTv.setState((s) => ({ [list]: s[list].includes(key) ? s[list].filter((x) => x !== key) : [...s[list], key] }) as Partial<TvData>);
}

// ---------- personal channels ----------

export function createPersonal(input: { name: string; number?: number; color: string; items?: PersonalItem[]; order?: PersonalChannel["order"]; seed?: number }, takenNumbers: number[] = []) {
  const s = useTv.getState();
  const now = Date.now();
  const ch: PersonalChannel = {
    id: `p${now.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    name: input.name.trim() || 'My Channel',
    number: input.number ?? nextNumber([...takenNumbers, ...s.personal.map((p) => p.number)]),
    color: input.color,
    items: input.items ?? [],
    order: input.order ?? 'sequential',
    seed: input.seed ?? Math.floor(Math.random() * 2 ** 31),
    anchor: { at: now, index: 0 },
    createdAt: now,
  };
  useTv.setState({ personal: [...s.personal, ch] });
  return ch;
}

export function updatePersonal(id: string, patch: Partial<Pick<PersonalChannel, 'items' | 'order' | 'seed' | 'name' | 'number' | 'color'>>) {
  const s = useTv.getState();
  useTv.setState({ personal: s.personal.map((c) => (c.id === id ? editChannel(c, patch, s.durations, Date.now()) : c)) });
}

export function deletePersonal(id: string) {
  useTv.setState((s) => ({ personal: s.personal.filter((c) => c.id !== id) }));
}

/** The item on air finished playing: start the next one now. */
export function personalEnded(id: string, finishedIndex: number) {
  const s = useTv.getState();
  useTv.setState({ personal: s.personal.map((c) => (c.id === id ? { ...c, anchor: advance(c, s.durations, Date.now(), finishedIndex) } : c)) });
}

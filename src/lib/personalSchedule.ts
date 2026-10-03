/**
 * Personal ("My Channels") linear scheduling — pure functions, no React/store.
 *
 * A personal channel is a looping list of movies/episodes. What is on at wall-clock time T
 * is fully determined by:
 *   - the ordered item list (playlist order, or a seeded shuffle that is stable for a seed),
 *   - each item's duration (known = measured while playing; otherwise an estimate:
 *     100 min for a movie, 45 min for an episode),
 *   - an ANCHOR {at, index}: "item `index` of the ordered list started at `at`".
 * From the anchor the timeline repeats forever in both directions (loop of length L = sum
 * of durations), so position(T) = ((T - at) mod L) walked through the cumulative durations.
 *
 * Self-correcting: when a real duration is learned (or an item ends early/late), the channel
 * is REBASED — the anchor moves to the start of the item on air now. The present (current item
 * and its offset) stays exactly where it was; everything after it uses the corrected durations.
 * Item list edits and reshuffles rebase the same way, keeping the current item if it remains.
 */

export type PersonalKind = 'movie' | 'series';

export interface PersonalItem {
  /** Playlist channel id of the movie/episode. */
  id: string;
  kind: PersonalKind;
  /** Display title saved with the item (shown even if the playlist is not loaded). */
  title: string;
  /** e.g. "S1 E2" for episodes. */
  subtitle?: string;
}

export interface Anchor {
  /** Epoch ms when ordered item `index` started. */
  at: number;
  index: number;
}

export interface PersonalChannel {
  id: string;
  name: string;
  number: number;
  color: string;
  items: PersonalItem[];
  order: 'sequential' | 'shuffle';
  seed: number;
  anchor: Anchor;
  createdAt: number;
}

export interface Slot {
  /** Position in the ordered list. */
  index: number;
  item: PersonalItem;
  start: number;
  end: number;
  /** Seconds into the item at the queried time (0 for listings after the first). */
  offset: number;
}

export const EST_MOVIE_SEC = 100 * 60;
export const EST_EPISODE_SEC = 45 * 60;
/** Durations below this are treated as unknown/bogus (trailers, failed probes). */
export const MIN_DURATION_SEC = 60;

export type Durations = Record<string, number | undefined>;

export function durationSec(item: Pick<PersonalItem, 'id' | 'kind'>, known: Durations): number {
  const d = known[item.id];
  if (d && Number.isFinite(d) && d >= MIN_DURATION_SEC) return d;
  return item.kind === 'movie' ? EST_MOVIE_SEC : EST_EPISODE_SEC;
}

/** Small fast seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher–Yates: the same items + seed always give the same order. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const orderCache = new WeakMap<PersonalItem[], Map<string, PersonalItem[]>>();
export function orderedItems(ch: Pick<PersonalChannel, 'items' | 'order' | 'seed'>): PersonalItem[] {
  if (ch.order !== 'shuffle') return ch.items;
  let m = orderCache.get(ch.items);
  if (!m) orderCache.set(ch.items, (m = new Map()));
  const key = String(ch.seed);
  let v = m.get(key);
  if (!v) m.set(key, (v = seededShuffle(ch.items, ch.seed)));
  return v;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** What is on at time `t` (undefined for an empty channel). */
export function slotAt(ch: Pick<PersonalChannel, 'items' | 'order' | 'seed' | 'anchor'>, known: Durations, t: number): Slot | undefined {
  const list = orderedItems(ch);
  const n = list.length;
  if (!n) return undefined;
  const a = mod(ch.anchor.index, n);
  const durMs = new Array<number>(n);
  let total = 0;
  for (let k = 0; k < n; k++) {
    durMs[k] = durationSec(list[(a + k) % n], known) * 1000;
    total += durMs[k];
  }
  const q = mod(t - ch.anchor.at, total);
  const cycleStart = t - q;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    if (q < acc + durMs[k]) {
      const start = cycleStart + acc;
      return { index: (a + k) % n, item: list[(a + k) % n], start, end: start + durMs[k], offset: (t - start) / 1000 };
    }
    acc += durMs[k];
  }
  // Floating point edge: treat as the start of the next cycle.
  return { index: a, item: list[a], start: cycleStart + total, end: cycleStart + total + durMs[0], offset: 0 };
}

/** Slots overlapping [from, to), in order. */
export function listings(ch: Pick<PersonalChannel, 'items' | 'order' | 'seed' | 'anchor'>, known: Durations, from: number, to: number, max = 500): Slot[] {
  const first = slotAt(ch, known, from);
  if (!first) return [];
  const list = orderedItems(ch);
  const out: Slot[] = [first];
  let { index, end } = first;
  while (end < to && out.length < max) {
    index = (index + 1) % list.length;
    const item = list[index];
    const d = durationSec(item, known) * 1000;
    out.push({ index, item, start: end, end: end + d, offset: 0 });
    end += d;
  }
  return out;
}

/**
 * Anchor at the start of the item on air at `now` (computed with the durations that were in
 * effect so far). Using it with new durations keeps the current item and offset unchanged.
 */
export function rebase(ch: Pick<PersonalChannel, 'items' | 'order' | 'seed' | 'anchor'>, known: Durations, now: number): Anchor {
  const s = slotAt(ch, known, now);
  return s ? { at: s.start, index: s.index } : { at: now, index: 0 };
}

/**
 * Apply an edit (new items / order / seed) while keeping the item on air now playing:
 * its position in the new order is looked up by id; if it was removed, the channel starts
 * the item now at the same position.
 */
export function editChannel(
  ch: PersonalChannel,
  patch: Partial<Pick<PersonalChannel, 'items' | 'order' | 'seed' | 'name' | 'number' | 'color'>>,
  known: Durations,
  now: number,
): PersonalChannel {
  const cur = slotAt(ch, known, now);
  const next: PersonalChannel = { ...ch, ...patch };
  const list = orderedItems(next);
  if (!list.length) return { ...next, anchor: { at: now, index: 0 } };
  if (!cur) return { ...next, anchor: { at: now, index: 0 } };
  const idx = list.findIndex((x) => x.id === cur.item.id);
  return { ...next, anchor: idx >= 0 ? { at: cur.start, index: idx } : { at: now, index: Math.min(cur.index, list.length - 1) } };
}

/** The item on air finished playing at `now`: start the following item now. */
export function advance(ch: PersonalChannel, known: Durations, now: number, finishedIndex?: number): Anchor {
  const n = orderedItems(ch).length;
  if (!n) return { at: now, index: 0 };
  const i = finishedIndex ?? slotAt(ch, known, now)?.index ?? 0;
  return { at: now, index: (i + 1) % n };
}

/** Next free channel number from 900 up. */
export function nextNumber(taken: Iterable<number>, from = 900): number {
  const used = new Set(taken);
  let n = from;
  while (used.has(n)) n++;
  return n;
}

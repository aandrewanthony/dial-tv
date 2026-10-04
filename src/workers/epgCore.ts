/**
 * Guide (EPG) core shared by the guide Web Worker and the main thread:
 *  - playlist channel → EPG channel resolution (tvg-id, names, manual) + auto-match suggestions
 *  - GuideCollector: windowed, de-duplicated programme storage while parsing
 *  - the compact cache format (one Int32Array + one string table) and its decoder
 * No DOM, no store imports: it must run inside a worker and in unit tests.
 */
import { normalizeName } from '../lib/channelMatch';
import { fixEnds, SPORTS_RE, type RawProgramme, type XmltvChannel } from '../lib/xmltv';

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
/** Programmes are kept from this long ago… */
export const GUIDE_BACK = 6 * HOUR;
export const DEFAULT_DAYS = 3;
export const MAX_DAYS = 7;

export interface EpgChannelInfo extends XmltvChannel {
  /** Index of the source whose programmes are stored for this channel (undefined: none stored). */
  s?: number;
  /** 1 when a playlist channel matched it at load time (its programmes were kept, if it had any). */
  w?: 1;
}

/** What the resolver needs from a playlist channel. */
export interface MatchChannel {
  id: string;
  name: string;
  tvgId?: string;
}

export type MatchHow = 'manual' | 'tvg-id' | 'name' | 'similar';
export interface Resolved {
  key: string;
  how: MatchHow;
}

// ---------- names ----------

const PREFIX_RE = /^\s*(?:\[[^\]]{1,24}\]|\([A-Za-z]{2,7}\)|[A-Za-z]{2,7}\s*[|:▎┃]|[A-Za-z]{2,7}\s+[-–]\s+)\s*/;
const QUALITY_RE = /\b(?:hd|fhd|uhd|sd|hq|lq|4k|8k|hevc|h\.?26[45]|x26[45]|\d{3,4}p|\d{2}fps|backup|raw|vip|multi|plus\s*\d*\s*hd)\b/g;

/**
 * Normalized display name for matching: country/group prefixes and quality tags stripped.
 * "US| ESPN FHD" → "espn", "[UK] Sky Sports Main Event HD" → "sky sports main event".
 */
export function epgNameKey(s: string): string {
  let t = s;
  for (let i = 0; i < 2; i++) {
    const r = t.replace(PREFIX_RE, '');
    if (r === t || !r.trim()) break;
    t = r;
  }
  return normalizeName(t).replace(QUALITY_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** tvg-id without a trailing country/region suffix: "ESPN.us" → "espn". */
const idStem = (id: string) => id.toLowerCase().replace(/\.[a-z]{2,3}(?:\.[a-z]{2,3})?$/, '').replace(/[^\p{L}\p{N}]+/gu, '');

const tokens = (s: string) => s.split(' ').filter((t) => t.length > 0);

/**
 * Matches playlist channels to EPG channels. Order: manual mapping, tvg-id (exact, then
 * case-insensitive), display name (exact, case-insensitive), normalized name (prefixes and
 * quality tags stripped).
 */
export class EpgMatcher {
  private byId = new Map<string, string>();
  private byIdLower = new Map<string, string>();
  private byName = new Map<string, string>();
  private byNorm = new Map<string, string>();
  private tokenIdx: Map<string, string[]> | null = null;
  private normOf = new Map<string, string>();
  readonly names = new Map<string, string>();

  constructor(readonly epg: XmltvChannel[]) {
    for (const c of epg) {
      if (!this.byId.has(c.id)) this.byId.set(c.id, c.id);
      const lo = c.id.toLowerCase();
      if (!this.byIdLower.has(lo)) this.byIdLower.set(lo, c.id);
      this.names.set(c.id, c.names[0] ?? c.id);
      for (const n of c.names) {
        const l = n.trim().toLowerCase();
        if (l && !this.byName.has(l)) this.byName.set(l, c.id);
        const k = epgNameKey(n);
        if (k && !this.byNorm.has(k)) this.byNorm.set(k, c.id);
        if (k && !this.normOf.has(c.id)) this.normOf.set(c.id, k);
      }
    }
  }

  has(key: string) {
    return this.byId.has(key);
  }

  resolve(c: MatchChannel, manual?: Record<string, string>): Resolved | undefined {
    const m = manual?.[c.id];
    if (m) return { key: m, how: 'manual' };
    if (c.tvgId) {
      const k = this.byId.get(c.tvgId) ?? this.byIdLower.get(c.tvgId.toLowerCase());
      if (k) return { key: k, how: 'tvg-id' };
    }
    const exact = this.byName.get(c.name.trim().toLowerCase());
    if (exact) return { key: exact, how: 'name' };
    const norm = epgNameKey(c.name);
    const k = norm ? this.byNorm.get(norm) : undefined;
    if (k) return { key: k, how: 'similar' };
    return undefined;
  }

  /** Resolve many channels. Channels with no match are absent from the map. */
  resolveAll(channels: MatchChannel[], manual?: Record<string, string>): Map<string, Resolved> {
    const out = new Map<string, Resolved>();
    for (const c of channels) {
      const r = this.resolve(c, manual);
      if (r) out.set(c.id, r);
    }
    return out;
  }

  /** Best guesses for an unmatched channel, with a 0–1 confidence. */
  suggest(c: MatchChannel, limit = 3): { key: string; name: string; confidence: number }[] {
    if (!this.tokenIdx) {
      this.tokenIdx = new Map();
      for (const [id, k] of this.normOf) {
        for (const t of new Set(tokens(k))) {
          const arr = this.tokenIdx.get(t);
          if (arr) arr.push(id);
          else this.tokenIdx.set(t, [id]);
        }
      }
    }
    const mine = new Set(tokens(epgNameKey(c.name)));
    const stem = c.tvgId ? idStem(c.tvgId) : '';
    const cand = new Map<string, number>();
    for (const t of mine) {
      const ids = this.tokenIdx.get(t);
      // Very common tokens ("tv", "news") are weak evidence: skip them when they'd flood the list.
      if (!ids || ids.length > 400) continue;
      for (const id of ids) cand.set(id, (cand.get(id) ?? 0) + 1);
    }
    if (stem) for (const [id] of this.byId) if (idStem(id) === stem) cand.set(id, (cand.get(id) ?? 0) + 0);
    const scored: { key: string; name: string; confidence: number }[] = [];
    for (const [id, shared] of cand) {
      const theirs = new Set(tokens(this.normOf.get(id) ?? ''));
      const union = new Set([...mine, ...theirs]).size || 1;
      let conf = shared / union;
      if (stem && idStem(id) === stem) conf = Math.max(conf, 0.85);
      // Numbers must agree ("ESPN 2" is not "ESPN").
      const nm = [...mine].filter((t) => /^\d+$/.test(t)).join();
      const nt = [...theirs].filter((t) => /^\d+$/.test(t)).join();
      if (nm !== nt) conf *= 0.5;
      if (conf >= 0.2) scored.push({ key: id, name: this.names.get(id) ?? id, confidence: Math.round(conf * 100) / 100 });
    }
    return scored.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name)).slice(0, limit);
  }
}

// ---------- compact cache ----------

/** Row layout of GuideCache.data. */
export const STRIDE = 7;
export const F_SPORTS = 1;
export const F_NEW = 2;

export interface GuideSourceMeta {
  id: string;
  name?: string;
  programmes: number;
  channels: number;
  error?: string;
  bytes?: number;
}

/**
 * The stored guide. Programmes are stored ONCE per EPG channel (never copied per playlist
 * channel): `data` holds STRIDE ints per programme — [channelIdx, startSec, endSec, titleIdx,
 * subtitleIdx, descIdx, (categoryIdx << 2) | flags] — sorted by channel then start, with times
 * in seconds from `base` and strings indexing `strings.split('\0')` (-1 = none).
 */
export interface GuideCache {
  v: 1;
  savedAt: number;
  from: number;
  to: number;
  days: number;
  base: number;
  /** JSON of EpgChannelInfo[] — every EPG channel seen (for the mapping picker), `s` set on stored ones. */
  channels: string;
  strings: string;
  data: Int32Array;
  sources: GuideSourceMeta[];
  /** Programmes scanned in total (before windowing / skipping unmatched channels). */
  scanned: number;
}

export interface DecodedGuide {
  cache: GuideCache;
  channels: EpgChannelInfo[];
  strings: string[];
  /** channelIdx → [firstRow, endRow) in data (rows, not ints). */
  ranges: Map<number, [number, number]>;
  count: number;
}

export function decodeGuide(cache: GuideCache): DecodedGuide {
  const channels = JSON.parse(cache.channels) as EpgChannelInfo[];
  const strings = cache.strings ? cache.strings.split('\u0000') : [];
  const ranges = new Map<number, [number, number]>();
  const d = cache.data;
  const count = Math.floor(d.length / STRIDE);
  let cur = -1;
  let first = 0;
  for (let r = 0; r < count; r++) {
    const c = d[r * STRIDE];
    if (c !== cur) {
      if (cur >= 0) ranges.set(cur, [first, r]);
      cur = c;
      first = r;
    }
  }
  if (cur >= 0) ranges.set(cur, [first, count]);
  return { cache, channels, strings, ranges, count };
}

/** Plain programme fields of one row (the caller sets id/channelId). */
export function rowFields(g: DecodedGuide, r: number) {
  const d = g.cache.data;
  const o = r * STRIDE;
  const s = g.strings;
  const cf = d[o + 6];
  const ci = cf >> 2;
  return {
    start: g.cache.base + d[o + 1] * 1000,
    end: g.cache.base + d[o + 2] * 1000,
    title: s[d[o + 3]] ?? '',
    subtitle: d[o + 4] >= 0 ? s[d[o + 4]] : undefined,
    description: d[o + 5] >= 0 ? s[d[o + 5]] : undefined,
    category: ci > 0 ? s[ci - 1] : 'General',
    isSports: (cf & F_SPORTS) !== 0,
    isNew: (cf & F_NEW) !== 0,
  };
}

/**
 * Collects programmes while parsing: windowed to [from, to), only for channels `wanted`, and
 * one source per EPG channel (the first source that has programmes for it wins).
 */
export class GuideCollector {
  private strIdx = new Map<string, number>();
  private strs: string[] = [];
  private chIdx = new Map<string, number>();
  private chans: EpgChannelInfo[] = [];
  /** channelIdx → flat [start, stop|NaN, title, sub, desc, catFlags, …] */
  private rows = new Map<number, number[]>();
  scanned = 0;
  kept = 0;

  constructor(readonly from: number, readonly to: number) {}

  private str(s: string | undefined): number {
    if (s == null) return -1;
    let i = this.strIdx.get(s);
    if (i == null) {
      i = this.strs.length;
      // The table is joined with NUL: strip any (they are invalid in XML anyway).
      this.strs.push(s.indexOf('\u0000') >= 0 ? s.replace(/\u0000/g, '') : s);
      this.strIdx.set(s, i);
    }
    return i;
  }

  private chan(id: string): number {
    let i = this.chIdx.get(id);
    if (i == null) {
      i = this.chans.length;
      this.chans.push({ id, names: [] });
      this.chIdx.set(id, i);
    }
    return i;
  }

  /** Register an EPG channel (first declaration wins; later sources add missing names/icon). */
  addChannel(c: XmltvChannel) {
    const i = this.chan(c.id);
    const cur = this.chans[i];
    for (const n of c.names) if (!cur.names.includes(n)) cur.names.push(n);
    if (!cur.icon && c.icon) cur.icon = c.icon;
  }

  /** Remember that a playlist channel wanted this guide channel at load time. */
  markWanted(id: string) {
    this.chans[this.chan(id)].w = 1;
  }

  /** Whether a programme for `channel` from source `src` would be stored (call before parsing its body). */
  wants(channel: string, src: number): boolean {
    const i = this.chIdx.get(channel);
    const s = i == null ? undefined : this.chans[i].s;
    return s == null || s === src;
  }

  add(p: RawProgramme, src: number) {
    const i = this.chan(p.channel);
    const c = this.chans[i];
    if (c.s == null) c.s = src;
    else if (c.s !== src) return;
    let arr = this.rows.get(i);
    if (!arr) this.rows.set(i, (arr = []));
    const title = p.title!;
    const cat = p.categories[0];
    const flags = (p.categories.some((x) => SPORTS_RE.test(x)) || SPORTS_RE.test(title) ? F_SPORTS : 0) | (p.isNew ? F_NEW : 0);
    arr.push(p.start, p.stop == null ? NaN : p.stop, this.str(title), this.str(p.subtitle), this.str(p.desc), ((cat ? this.str(cat) + 1 : 0) << 2) | flags);
  }

  /** Programmes added so far (before the final window/fix-up pass). */
  get size() {
    let n = 0;
    for (const a of this.rows.values()) n += a.length / 6;
    return n;
  }

  /** Channel ids that have stored programmes, per source index. */
  channelsOf(src: number) {
    let n = 0;
    for (const c of this.chans) if (c.s === src) n++;
    return n;
  }

  finish(meta: { savedAt: number; days: number; sources: GuideSourceMeta[] }): GuideCache {
    const base = Math.floor(this.from / 1000) * 1000;
    const out: number[][] = [];
    let total = 0;
    const order = [...this.rows.keys()].sort((a, b) => a - b);
    const kept = new Map<number, number>();
    for (const ci of order) {
      const a = this.rows.get(ci)!;
      const n = a.length / 6;
      // Sort rows by start when needed (guides are usually sorted already).
      let idx = Array.from({ length: n }, (_, k) => k);
      let sorted = true;
      for (let k = 1; k < n; k++) if (a[k * 6] < a[(k - 1) * 6]) { sorted = false; break; }
      if (!sorted) idx = idx.sort((x, y) => a[x * 6] - a[y * 6]);
      // Drop exact duplicate starts (the same airing listed twice).
      idx = idx.filter((k, j) => j === 0 || a[k * 6] !== a[idx[j - 1] * 6]);
      const starts = idx.map((k) => a[k * 6]);
      const ends = idx.map((k) => a[k * 6 + 1]);
      fixEnds(starts, ends);
      const rows: number[] = [];
      for (let j = 0; j < idx.length; j++) {
        const st = starts[j];
        const en = ends[j];
        if (!(en > st && en > this.from && st < this.to)) continue;
        const k = idx[j] * 6;
        rows.push(ci, Math.round((st - base) / 1000), Math.round((en - base) / 1000), a[k + 2], a[k + 3], a[k + 4], a[k + 5]);
      }
      if (rows.length) {
        out.push(rows);
        total += rows.length;
        kept.set(ci, rows.length / STRIDE);
      }
    }
    // Channels whose programmes were all outside the window don't count as stored.
    for (let i = 0; i < this.chans.length; i++) if (!kept.has(i)) delete this.chans[i].s;
    const data = new Int32Array(total);
    let o = 0;
    for (const r of out) {
      data.set(r, o);
      o += r.length;
    }
    this.kept = total / STRIDE;
    const sources = meta.sources.map((s, i) => ({ ...s, channels: this.channelsOf(i), programmes: 0 }));
    for (const [ci, n] of kept) {
      const s = this.chans[ci].s;
      if (s != null && sources[s]) sources[s].programmes += n;
    }
    return {
      v: 1,
      savedAt: meta.savedAt,
      from: this.from,
      to: this.to,
      days: meta.days,
      base,
      channels: JSON.stringify(this.chans),
      strings: this.strs.join('\u0000'),
      data,
      sources,
      scanned: this.scanned,
    };
  }
}

/** The guide's time window for `days` days ahead of `now`. */
export function guideWindow(now: number, days: number) {
  const d = Math.min(MAX_DAYS, Math.max(1, Math.round(days) || DEFAULT_DAYS));
  return { from: now - GUIDE_BACK, to: now + d * DAY, days: d };
}

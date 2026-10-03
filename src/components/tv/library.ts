import type { Channel } from '../../types';
import { vodItems } from '../../store/app';

/** A show and its episodes, grouped from playlist episodes (memoized per channels array). */
export interface Show {
  key: string;
  name: string;
  /** Poster: first episode logo found. */
  logo?: string;
  group: string;
  /** Playlist order of the first episode (for "recently added"). */
  order: number;
  seasons: { season: number; episodes: Channel[] }[];
  /** All episodes in watch order (season, episode, then playlist order). */
  episodes: Channel[];
  lower: string;
}

export interface Library {
  movies: Channel[];
  episodes: Channel[];
  shows: Show[];
  showByKey: Map<string, Show>;
  /** VOD id → item (movies + episodes). */
  byId: Map<string, Channel>;
  /** Episode id → show key. */
  showOf: Map<string, string>;
  /** Playlist order index of every VOD item. */
  order: Map<string, number>;
  movieGroups: string[];
  seriesGroups: string[];
  years: number[];
  /** Lowercased search text per movie id. */
  lower: Map<string, string>;
}

export const showKey = (name: string) => `show:${name.toLowerCase()}`;
export const titleOf = (c: Channel) => c.title || c.name;
export const epLabel = (c: Channel) => (c.series ? `S${c.series.season} E${c.series.episode}` : '');
/** Episode name without the show name and S01E02 marker ("Pilot"), or "Episode 2". */
export function episodeName(c: Channel): string {
  const t = titleOf(c);
  if (!c.series) return t;
  const show = c.series.show.toLowerCase();
  let rest = t.toLowerCase().startsWith(show) ? t.slice(show.length) : t;
  rest = rest
    .replace(/\bS\d{1,2}[\s._-]*E\d{1,4}\b|\b\d{1,2}x\d{1,3}\b|\b(?:Season|Temporada|Saison|Staffel)\s*\d+\s*\S*\s*\d+\b/i, '')
    .replace(/^[\s:|·.-]+|[\s:|·.-]+$/g, '');
  return rest || `Episode ${c.series.episode}`;
}

const cache = new WeakMap<Channel[], Library>();

export function buildLibrary(channels: Channel[]): Library {
  const hit = cache.get(channels);
  if (hit) return hit;
  const { movies, episodes } = vodItems(channels);
  const order = new Map<string, number>();
  channels.forEach((c, i) => c.kind && c.kind !== 'live' && order.set(c.id, i));
  const byId = new Map<string, Channel>();
  const lower = new Map<string, string>();
  const mg = new Set<string>();
  const years = new Set<number>();
  for (const m of movies) {
    byId.set(m.id, m);
    lower.set(m.id, `${titleOf(m)} ${m.name} ${m.group} ${m.year ?? ''}`.toLowerCase());
    mg.add(m.group);
    if (m.year) years.add(m.year);
  }
  const showByKey = new Map<string, Show>();
  const showOf = new Map<string, string>();
  const sg = new Set<string>();
  for (const e of episodes) {
    byId.set(e.id, e);
    const name = e.series?.show || e.group;
    const key = showKey(name);
    showOf.set(e.id, key);
    let s = showByKey.get(key);
    if (!s) {
      s = { key, name, logo: e.logo, group: e.group, order: order.get(e.id) ?? 0, seasons: [], episodes: [], lower: name.toLowerCase() };
      showByKey.set(key, s);
      sg.add(e.group);
    }
    if (!s.logo && e.logo) s.logo = e.logo;
    s.episodes.push(e);
    if (e.year) years.add(e.year);
  }
  for (const s of showByKey.values()) {
    s.episodes.sort((a, b) =>
      (a.series?.season ?? 0) - (b.series?.season ?? 0) || (a.series?.episode ?? 0) - (b.series?.episode ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const bySeason = new Map<number, Channel[]>();
    for (const e of s.episodes) {
      const n = e.series?.season ?? 1;
      const arr = bySeason.get(n);
      if (arr) arr.push(e);
      else bySeason.set(n, [e]);
    }
    s.seasons = [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([season, eps]) => ({ season, episodes: eps }));
  }
  const lib: Library = {
    movies,
    episodes,
    shows: [...showByKey.values()],
    showByKey,
    byId,
    showOf,
    order,
    movieGroups: [...mg].sort((a, b) => a.localeCompare(b)),
    seriesGroups: [...sg].sort((a, b) => a.localeCompare(b)),
    years: [...years].sort((a, b) => b - a),
    lower,
  };
  cache.set(channels, lib);
  return lib;
}

/** The episode after `id` in its show (watch order), if any. */
export function nextEpisode(lib: Library, id: string): Channel | undefined {
  const s = lib.showByKey.get(lib.showOf.get(id) ?? '');
  if (!s) return undefined;
  const i = s.episodes.findIndex((e) => e.id === id);
  return i >= 0 ? s.episodes[i + 1] : undefined;
}

/** Deterministic hue from a string, for poster fallbacks. */
export function hueOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

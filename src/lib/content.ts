/**
 * Splits a playlist into Live TV, Movies and Series episodes. IPTV playlists mix all three;
 * we use (in order) explicit tvg-type, Xtream URL paths (/live/ /movie/ /series/), episode
 * naming (S01E02, 1x02), VOD-looking group names, and media file extensions.
 */
export type ContentKind = 'live' | 'movie' | 'series';

export interface ContentInfo {
  kind: ContentKind;
  /** Clean title without year / episode markers / quality tags. */
  title?: string;
  year?: number;
  series?: { show: string; season: number; episode: number };
}

const VOD_EXT = /\.(mp4|mkv|avi|mov|m4v|wmv|webm|mpg|mpeg|flv)$/i;
const LIVE_EXT = /\.(m3u8|ts)$/i;
const MOVIE_GROUP = /\b(vod|movies?|films?|cinema|pel[ií]culas?|filmes?|4k movies|box ?office)\b/i;
const SERIES_GROUP = /\b(series|tv ?shows?|seasons?|episodes?|s[ée]ries)\b/i;
const EPISODE = /^(.*?)[\s._-]*(?:\bS(\d{1,2})[\s._-]*E(\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b|\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})\b)/i;
const QUALITY = /\s*[[(]?(?:4k|uhd|fhd|hd|sd|1080p|720p|480p|2160p|hevc|x26[45]|multi|vostfr|dual audio)[\])]?\s*/gi;

function cleanTitle(s: string) {
  return s
    .replace(/^\s*(\[[^\]]*\]|[A-Z]{2,3}\s*[:|])\s*/i, '') // "EN| ", "[US] "
    .replace(QUALITY, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s:|-]+$/, '')
    .trim();
}

function yearOf(s: string): { title: string; year?: number } {
  const m = /^(.*?)[\s([]+((?:19|20)\d{2})[)\]]?\s*$/.exec(s);
  if (m && m[1].trim()) return { title: m[1].trim(), year: +m[2] };
  return { title: s };
}

export function classifyContent(input: { name: string; group?: string; url: string; type?: string }): ContentInfo {
  const name = input.name ?? '';
  const group = input.group ?? '';
  const path = (() => { try { return new URL(input.url).pathname; } catch { return input.url.split('?')[0]; } })();
  const type = (input.type ?? '').toLowerCase();

  const ep = EPISODE.exec(name);
  const episodeInfo = ep
    ? {
      show: cleanTitle(ep[1] || group) || cleanTitle(group) || 'Unknown show',
      season: +(ep[2] ?? ep[4] ?? ep[6]),
      episode: +(ep[3] ?? ep[5] ?? ep[7]),
    }
    : undefined;

  let kind: ContentKind;
  if (type === 'live' || type === 'movie' || type === 'series') kind = type;
  else if (/\/series\//i.test(path)) kind = 'series';
  else if (/\/movies?\//i.test(path)) kind = episodeInfo ? 'series' : 'movie';
  else if (/\/live\//i.test(path) || /^(udp|rtp|rtsp|rtmps?|srt|mms[ht]?):/i.test(input.url)) kind = 'live';
  else if (episodeInfo && (VOD_EXT.test(path) || SERIES_GROUP.test(group) || MOVIE_GROUP.test(group))) kind = 'series';
  else if (VOD_EXT.test(path)) kind = 'movie';
  else if (SERIES_GROUP.test(group) && episodeInfo) kind = 'series';
  else if (MOVIE_GROUP.test(group) && !LIVE_EXT.test(path)) kind = 'movie';
  else if (MOVIE_GROUP.test(group) && /\bvod\b/i.test(group)) kind = 'movie';
  else kind = 'live';

  if (kind === 'live') return { kind };
  if (kind === 'series') {
    const s = episodeInfo ?? { show: cleanTitle(group) || cleanTitle(name), season: 1, episode: 0 };
    return { kind, title: cleanTitle(name), series: s };
  }
  const { title, year } = yearOf(cleanTitle(name));
  return { kind, title, ...(year ? { year } : {}) };
}

/**
 * Splits a playlist into Live TV, Movies and Series episodes. IPTV playlists mix all three;
 * we use (strongest first): explicit tvg-type, Xtream URL paths (/live/ /movie/ /series/),
 * media file extensions, episode naming (S01E02, 1x02, "Season 1 Episode 2"), and
 * VOD-looking group names (in several languages). A group called "Movies" alone is NOT
 * enough for an extension-less stream: providers put live movie channels (HBO, Cinemax...)
 * in such groups, so we also want a year in the name or an explicit "VOD" group.
 */
export type ContentKind = 'live' | 'movie' | 'series';

export interface ContentInfo {
  kind: ContentKind;
  /** Clean title without year / episode markers / quality tags. */
  title?: string;
  year?: number;
  series?: { show: string; season: number; episode: number };
}

const VOD_EXT = /\.(mp4|mkv|avi|mov|m4v|wmv|webm|mpg|mpeg|flv|divx|xvid|3gp|ogv)$/i;
const LIVE_EXT = /\.(m3u8?|ts)$/i;
// Letter-boundaries that also work for non-Latin scripts (\b is ASCII-only).
const W = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${s})(?![\\p{L}])`, 'iu');
/** Movie / VOD groups: EN, ES, PT, FR, DE, IT, NL, TR, PL, RU, AR, + common provider labels. */
const MOVIE_GROUP = W(
  'vod|movies?|films?|filmes?|filme|cin[eé]ma|cine|pel[ií]culas?|peliculas?|kino|filmy|filmler|' +
  'box ?office|4k movies|фильмы|кино|أفلام|افلام|फ़िल्में',
);
/** Series groups: EN, ES, PT, FR, DE, IT, NL, TR, PL, RU, AR. */
const SERIES_GROUP = W(
  'series|serie|s[ée]ries|serien|seriale?|seizoen|dizi(?:ler)?|tv ?shows?|shows|seasons?|episodes?|temporadas?|saison|staffel|' +
  'сериалы|сериал|مسلسلات|مسلسل',
);
/** "VOD" spelled out: strong evidence even without an extension. */
const VOD_WORD = W('vod|on ?demand|movies? vod|series vod');
const EPISODE = new RegExp(
  '^(.*?)[\\s._\\-|:]*(?:' +
  '\\bS(\\d{1,2})[\\s._-]*E(\\d{1,4})\\b' + // S01E02, S1 E2, S01.E02
  '|\\b(\\d{1,2})x(\\d{1,3})\\b' + // 1x02
  '|\\b(?:Season|Temporada|Saison|Staffel|Stagione|Seizoen|Sezon)[\\s._-]*(\\d{1,2})[\\s._,-]*(?:Episode|Ep\\.?|Episodio|Episódio|[ÉE]pisode|Folge|Aflevering|B[öo]l[üu]m)[\\s._-]*(\\d{1,4})\\b' +
  ')',
  'i',
);
const QUALITY = /[\s._-]*[[(]?\b(?:4k|uhd|fhd|hd|sd|1080p|720p|480p|2160p|hevc|h\.?26[45]|x26[45]|10bit|hdr10?|multi(?:-?sub)?|vostfr|vose|dual(?: audio)?|web-?dl|webrip|bluray|brrip|dvdrip|hdtv|aac|ac3|dd5\.1)\b[\])]?/gi;

function cleanTitle(s: string) {
  return s
    .replace(/^\s*(\[[^\]]*\]|\|[A-Z]{2,3}\|?|[A-Z]{2,3}(?:-[A-Z]{2})?\s*[:|]|[A-Z]{2,3}\s+-\s+)\s*/i, '') // "EN| ", "[US] ", "|FR| ", "NF - "
    .replace(VOD_EXT, '')
    .replace(QUALITY, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:|-]+|[\s:|-]+$/g, '')
    .trim();
}

function yearOf(s: string): { title: string; year?: number } {
  // "Title (2019)", "Title [2019]", "Title 2019", "Title - 2019"
  const m = /^(.*?)[\s([-]+((?:19|20)\d{2})[)\]]?\s*$/.exec(s);
  if (m && m[1].trim()) return { title: m[1].replace(/[\s:-]+$/, '').trim(), year: +m[2] };
  return { title: s };
}

const pathOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url.split(/[?#]/)[0];
  }
};

export function classifyContent(input: { name: string; group?: string; url: string; type?: string }): ContentInfo {
  const name = input.name ?? '';
  const group = input.group ?? '';
  const path = pathOf(input.url ?? '');
  const type = (input.type ?? '').toLowerCase();

  const ep = EPISODE.exec(name);
  const episodeInfo = ep
    ? {
      show: cleanTitle(ep[1] || '') || cleanTitle(group) || 'Unknown show',
      season: +(ep[2] ?? ep[4] ?? ep[6]),
      episode: +(ep[3] ?? ep[5] ?? ep[7]),
    }
    : undefined;
  const movieGroup = MOVIE_GROUP.test(group);
  const seriesGroup = SERIES_GROUP.test(group);
  const hasYear = /(?:^|[\s([-])(?:19|20)\d{2}[)\]]?\s*$/.test(cleanTitle(name));

  let kind: ContentKind;
  if (type === 'live' || type === 'movie' || type === 'series') kind = type;
  else if (/^(vod|movies?|film)$/.test(type)) kind = 'movie';
  else if (/^(tv|channel|stream)$/.test(type)) kind = 'live';
  else if (/\/series\//i.test(path)) kind = 'series';
  else if (/\/(movies?|vod)\//i.test(path)) kind = episodeInfo ? 'series' : 'movie';
  else if (/\/live\//i.test(path) || /^(udp|rtp|rtsp|rtmps?|srt|mms[ht]?):/i.test(input.url)) kind = 'live';
  else if (VOD_EXT.test(path)) kind = episodeInfo ? 'series' : 'movie';
  else if (LIVE_EXT.test(path)) {
    // HLS is usually live; only an explicit VOD group turns it into a movie/episode.
    kind = VOD_WORD.test(group) || (episodeInfo && (seriesGroup || movieGroup)) ? (episodeInfo ? 'series' : 'movie') : 'live';
  } else if (episodeInfo && (seriesGroup || movieGroup)) kind = 'series';
  else if (movieGroup && (VOD_WORD.test(group) || hasYear)) kind = 'movie';
  else kind = 'live';

  if (kind === 'live') return { kind };
  if (kind === 'series') {
    const s = episodeInfo ?? { show: cleanTitle(group) || cleanTitle(name), season: 1, episode: 0 };
    return { kind, title: cleanTitle(name), series: s };
  }
  const { title, year } = yearOf(cleanTitle(name));
  return { kind, title: title || cleanTitle(name) || name, ...(year ? { year } : {}) };
}

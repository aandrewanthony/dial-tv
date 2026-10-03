import type { Channel } from '../types';

/**
 * Smart Sports Mapper: resolve a broadcaster name ("NFL Net", "ESPN2", "FOX") to
 * a playlist channel using normalized aliases, returning a confidence score.
 */

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(hd|fhd|uhd|4k|sd|east|west|feed)\b/g, ' ')
    .replace(/&/g, 'and')
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip common IPTV group prefixes like "US: ", "USA | ", "[US] ". */
function stripPrefix(s: string) {
  return s.replace(/^\s*(\[[^\]]+\]|[A-Z]{2,3}\s*[:|])\s*/i, '');
}

/** Canonical network → aliases. Keys are canonical normalized names. */
export const NETWORK_ALIASES: Record<string, string[]> = {
  'espn': ['espn', 'espn hd', 'espn us'],
  'espn2': ['espn2', 'espn 2'],
  'espnu': ['espnu', 'espn u'],
  'espnews': ['espnews', 'espn news'],
  'abc': ['abc', 'abc network', 'wabc'],
  'cbs': ['cbs', 'cbs network', 'wcbs'],
  'nbc': ['nbc', 'nbc network', 'wnbc'],
  'fox': ['fox', 'fox network', 'wnyw', 'fox broadcasting'],
  'fs1': ['fs1', 'fox sports 1', 'fox sports one'],
  'fs2': ['fs2', 'fox sports 2'],
  'tnt': ['tnt', 'tnt sports', 'tnt usa'],
  'tbs': ['tbs'],
  'trutv': ['trutv', 'tru tv'],
  'nfl network': ['nfl net', 'nfl network', 'nfln', 'nfl'],
  'nfl redzone': ['nfl redzone', 'redzone', 'red zone'],
  'nba tv': ['nba tv', 'nbatv'],
  'mlb network': ['mlb network', 'mlb net', 'mlbn'],
  'nhl network': ['nhl network', 'nhl net', 'nhln'],
  'cbs sports network': ['cbs sports network', 'cbssn', 'cbs sports net'],
  'usa network': ['usa net', 'usa network', 'usa'],
  'big ten network': ['big ten network', 'btn', 'big 10 network'],
  'sec network': ['sec network', 'secn', 'sec'],
  'acc network': ['acc network', 'accn', 'acc'],
  'golf channel': ['golf', 'golf channel'],
  'msg': ['msg', 'msg network'],
  'msg2': ['msg2', 'msg 2'],
  'yes network': ['yes', 'yes network'],
  'sny': ['sny'],
  'peacock': ['peacock'],
  'prime video': ['prime video', 'amazon prime', 'tnf'],
  'espn plus': ['espn plus', 'espnplus'],
  'apple tv': ['apple tv', 'apple tv plus', 'mls season pass'],
  'netflix': ['netflix'],
  'universo': ['universo'],
  'telemundo': ['telemundo'],
  'univision': ['univision'],
  'tudn': ['tudn'],
  'fox deportes': ['fox deportes'],
  'espn deportes': ['espn deportes'],
};

const ALIAS_INDEX = (() => {
  const m = new Map<string, string>();
  for (const [canon, aliases] of Object.entries(NETWORK_ALIASES)) {
    m.set(canon, canon);
    for (const a of aliases) m.set(normalizeName(a), canon);
  }
  return m;
})();

export function canonicalNetwork(name: string): string {
  const n = normalizeName(stripPrefix(name));
  return ALIAS_INDEX.get(n) ?? n;
}

/** Trailing words that make a channel a *different* network (FOX News ≠ FOX, ESPN 2 ≠ ESPN). */
const VARIANT_WORDS = new Set([
  'news', 'business', 'sports', 'sport', 'deportes', 'plus', 'u', 'classic', 'college', 'soccer', 'life', 'weather',
  'kids', 'movies', 'family', 'extra', 'alt', 'two', 'max', 'network', 'net', 'radio', 'latino', 'espanol',
]);

/**
 * Canonical network for a channel name, also recognising local-affiliate style names
 * like "FOX New York" or "CBS 2 Chicago" via a guarded prefix match.
 */
function channelCanon(name: string): { canon: string; prefix: boolean } {
  const cn = normalizeName(stripPrefix(name));
  const direct = ALIAS_INDEX.get(cn);
  if (direct) return { canon: direct, prefix: false };
  const tokens = cn.split(' ');
  for (let k = Math.min(3, tokens.length - 1); k >= 1; k--) {
    const head = ALIAS_INDEX.get(tokens.slice(0, k).join(' '));
    if (!head) continue;
    const next = tokens[k];
    // "ESPN 2", "FOX News", "FOX Sports 1" are other networks; "FOX New York", "CBS WCBS" are affiliates.
    if (/^\d+$/.test(next) && tokens.length === k + 1) break;
    if (VARIANT_WORDS.has(next)) break;
    return { canon: head, prefix: true };
  }
  return { canon: cn, prefix: false };
}

export interface ChannelMatch {
  channel: Channel;
  confidence: number; // 0..1
  reason: 'manual' | 'exact' | 'alias' | 'fuzzy';
}

function tokenSim(a: string, b: string) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

/**
 * Find the best playlist channel for a broadcaster name.
 * @param overrides user corrections: canonical network → channel id
 */
export function matchNetwork(
  network: string,
  channels: Channel[],
  overrides: Record<string, string> = {},
): ChannelMatch | null {
  const canon = canonicalNetwork(network);
  const manual = overrides[canon];
  if (manual) {
    const ch = channels.find((c) => c.id === manual);
    if (ch) return { channel: ch, confidence: 1, reason: 'manual' };
  }
  let best: ChannelMatch | null = null;
  for (const ch of channels) {
    const cn = normalizeName(stripPrefix(ch.name));
    const { canon: chCanon, prefix } = channelCanon(ch.name);
    let score = 0;
    let reason: ChannelMatch['reason'] = 'fuzzy';
    if (chCanon === canon) {
      score = cn === canon ? 0.97 : prefix ? 0.85 : 0.9;
      reason = cn === canon ? 'exact' : 'alias';
    } else {
      // Avoid "espn" matching "espn2" etc: fuzzy requires token overlap, penalize extra tokens.
      score = tokenSim(cn, canon) * 0.75;
    }
    if (score > (best?.confidence ?? 0)) best = { channel: ch, confidence: score, reason };
  }
  return best && best.confidence >= 0.5 ? best : null;
}

/** Best match across all of a game's broadcasters (first listed wins ties). */
export function matchBroadcasts(
  broadcasts: string[],
  channels: Channel[],
  overrides: Record<string, string> = {},
): (ChannelMatch & { network: string }) | null {
  let best: (ChannelMatch & { network: string }) | null = null;
  for (const b of broadcasts) {
    const m = matchNetwork(b, channels, overrides);
    if (m && m.confidence > (best?.confidence ?? 0)) best = { ...m, network: b };
  }
  return best;
}

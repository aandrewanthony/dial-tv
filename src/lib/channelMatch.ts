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
    // Keep letters/digits of any script (plus combining marks) so non-Latin names don't collapse to ''.
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
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

/** Tokens that mark a regional/foreign feed ("TNT Sports 1 UK", "NBA TV Canada") — never the US network. */
const REGION_WORDS = new Set([
  'uk', 'gb', 'canada', 'ca', 'au', 'aus', 'australia', 'nz', 'mx', 'mexico', 'es', 'spain', 'de', 'germany', 'fr', 'france',
  'italy', 'pt', 'portugal', 'br', 'brasil', 'brazil', 'ar', 'argentina', 'latino', 'latam', 'latin',
  'international', 'intl', 'europe', 'eu', 'asia', 'africa', 'arabia', 'mena', 'india', 'ireland',
  'nl', 'pl', 'tr', 'sg', 'hk', 'jp', 'kr', 'caribbean', 'world', 'global',
]);

/** Over-the-air networks whose local affiliates carry a channel number ("CBS 2 Chicago"). */
const BROADCAST_HEADS = new Set(['abc', 'cbs', 'nbc', 'fox']);

/** Single words that are aliases but also common words/prefixes ("USA Today", "Golf Digest"): exact match only. */
const AMBIGUOUS_HEADS = new Set(['usa', 'yes', 'golf', 'sec', 'acc', 'nfl']);

/**
 * Canonical network for a channel name, also recognising local-affiliate style names
 * like "FOX New York" or "CBS 2 Chicago" via a guarded prefix match.
 */
function channelCanon(cn: string): { canon: string; prefix: boolean } {
  const direct = ALIAS_INDEX.get(cn);
  if (direct) return { canon: direct, prefix: false };
  const tokens = cn.split(' ');
  if (tokens.some((t) => REGION_WORDS.has(t))) return { canon: cn, prefix: false };
  for (let k = Math.min(3, tokens.length - 1); k >= 1; k--) {
    const headStr = tokens.slice(0, k).join(' ');
    const head = ALIAS_INDEX.get(headStr);
    if (!head) continue;
    if (AMBIGUOUS_HEADS.has(headStr)) break;
    const next = tokens[k];
    const rest = tokens.slice(k);
    // "ESPN 2", "FOX News", "FOX Sports 1" are other networks; "FOX New York", "CBS WCBS", "CBS 2 Chicago" are affiliates.
    if (VARIANT_WORDS.has(next)) break;
    if (rest.some((t) => /\d/.test(t))) {
      // Only a single affiliate channel number right after an OTA network, followed by a market name.
      const ok = BROADCAST_HEADS.has(head) && k === 1 && /^\d+$/.test(next) && rest.length > 1 && !rest.slice(1).some((t) => /\d/.test(t));
      if (!ok) break;
    }
    return { canon: head, prefix: true };
  }
  return { canon: cn, prefix: false };
}

interface Prepared {
  ch: Channel;
  cn: string;
  canon: string;
  prefix: boolean;
  /** Regional/foreign feed: never a fuzzy match for a US network. */
  region: boolean;
}

const prepCache = new WeakMap<Channel[], Prepared[]>();

/** Normalized/canonical names per channel, computed once per channels array. */
function prepared(channels: Channel[]): Prepared[] {
  let p = prepCache.get(channels);
  if (!p) {
    p = channels.map((ch) => {
      const cn = normalizeName(stripPrefix(ch.name));
      return { ch, cn, ...channelCanon(cn), region: cn.split(' ').some((t) => REGION_WORDS.has(t)) };
    });
    prepCache.set(channels, p);
  }
  return p;
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
  if (!canon) return null;
  const canonRegion = canon.split(' ').some((t) => REGION_WORDS.has(t));
  for (const { ch, cn, canon: chCanon, prefix, region } of prepared(channels)) {
    let score = 0;
    let reason: ChannelMatch['reason'] = 'fuzzy';
    if (chCanon === canon) {
      score = cn === canon ? 0.97 : prefix ? 0.85 : 0.9;
      reason = cn === canon ? 'exact' : 'alias';
    } else {
      // Avoid "espn" matching "espn2" etc: fuzzy requires token overlap, penalize extra tokens.
      score = region && !canonRegion ? 0 : tokenSim(cn, canon) * 0.75;
    }
    if (score > (best?.confidence ?? 0)) best = { channel: ch, confidence: score, reason };
  }
  return best && best.confidence >= 0.5 ? best : null;
}

type BroadcastMatch = (ChannelMatch & { network: string }) | null;

const NO_OVERRIDES: Record<string, string> = {};
/** channels array → overrides object → broadcasts key → result. Arrays/objects are replaced (not mutated) by the store. */
const broadcastCache = new WeakMap<Channel[], WeakMap<Record<string, string>, Map<string, BroadcastMatch>>>();

/** Best match across all of a game's broadcasters (first listed wins ties). Memoized per (channels, overrides, broadcasts). */
export function matchBroadcasts(
  broadcasts: string[],
  channels: Channel[],
  overrides: Record<string, string> = NO_OVERRIDES,
): BroadcastMatch {
  let byOv = broadcastCache.get(channels);
  if (!byOv) broadcastCache.set(channels, (byOv = new WeakMap()));
  let memo = byOv.get(overrides);
  if (!memo) byOv.set(overrides, (memo = new Map()));
  const key = broadcasts.join('\u0001');
  if (memo.has(key)) return memo.get(key)!;
  let best: BroadcastMatch = null;
  for (const b of broadcasts) {
    const m = matchNetwork(b, channels, overrides);
    if (m && m.confidence > (best?.confidence ?? 0)) best = { ...m, network: b };
  }
  if (memo.size > 5000) memo.clear();
  memo.set(key, best);
  return best;
}

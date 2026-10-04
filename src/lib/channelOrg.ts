/**
 * Channel organization for big provider playlists.
 *
 * Providers list the same channel many times ("US| ESPN", "US| ESPN FHD", "US| ESPN 4K",
 * "US| ESPN (Backup)") in hundreds of messy groups ("US| SPORTS", "UK - Sports", "[CA] News").
 * This module turns raw playlist entries into:
 *  - clean display names (raw name kept for EPG / broadcast matching),
 *  - one logical channel per real channel, with quality variants as fallbacks,
 *  - a clean group structure: country + category.
 *
 * Everything here is pure and memoized per channels array, so it's cheap to call in render.
 */
import type { Channel } from '../types';

// ---------------------------------------------------------------- categories

export type Category =
  | 'Sports' | 'News' | 'Locals' | 'Entertainment' | 'Movies' | 'Kids' | 'Music' | 'Documentary' | 'Religious' | 'Other';

/** Canonical category order (also the order the group picker shows). */
export const CATEGORIES: Category[] = ['Sports', 'News', 'Locals', 'Entertainment', 'Movies', 'Kids', 'Music', 'Documentary', 'Religious', 'Other'];

const GROUP_CAT: [Category, RegExp][] = [
  ['Religious', /relig|faith|christ|church|gospel|islam|quran|catholic|\bgod\b|worship/],
  ['Kids', /\bkids?\b|child|cartoon|junior|enfant|infantil|ni[nñ]os|kinder|bambini|animation|\bfamily\b/],
  ['Sports', /sport|deporte|esporte|football|soccer|\bnfl\b|\bnba\b|\bmlb\b|\bnhl\b|\bncaa|\bppv\b|espn|\bbein\b|\bdazn\b|\bgolf\b|tennis|\bf1\b|motor|racing|\bufc\b|boxing|\bwwe\b|cricket|rugby|f[uú]tbol|calcio|\bpga\b|\bmls\b|\bepl\b/],
  ['News', /news|noticia|\binfo\b|nachrichten|actualit|notizie|haber|journal/],
  ['Locals', /local|affiliate|\bnetworks?\b|regional|\bota\b|broadcast|\babc\b|\bcbs\b|\bnbc\b/],
  ['Music', /music|m[uú]sica|musique|\bradio\b|\bhits\b|\bmtv\b/],
  ['Documentary', /document|dokument|\bdocu|discovery|nature|history|science|knowledge|wildlife/],
  // Not "premium": providers use it for general cable ("USA Premium": TNT, HGTV, FX…); those go by channel name.
  ['Movies', /movie|cinema|\bcine\b|\bfilms?\b|pel[ií]cula|filme|\bhbo\b/],
  ['Entertainment', /entertain|general|variety|\bseries\b|\bshows?\b|lifestyle|comedy|drama|reality|divertis|entreten|intratten|unterhaltung|\bdiversos\b/],
];

const NAME_CAT: [Category, RegExp][] = [
  ['Kids', /cartoon|nick(elodeon| ?jr|toons)?\b|disney ?(channel|junior|jr|xd)|boomerang|pbs kids|baby ?tv|\bkids?\b|cbeebies|\bcbbc\b|\bjunior\b|universal kids|toon/],
  ['Religious', /\btbn\b|\bewtn\b|daystar|god ?tv|church|gospel|christian|faith|islam|quran|peace tv|catholic/],
  ['Sports', /espn|fox sports|\bfs[12]\b|\bnfl\b|\bnba\b|\bmlb\b|\bnhl\b|\bsec network|\bacc network|big ten|\bbtn\b|\bgolf\b|tennis|\bbein\b|\bdazn\b|sport|\btsn\b|setanta|\bufc\b|\bwwe\b|redzone|racing|\bf1\b|motogp|willow|nbcsn|\bmls\b|\bpac[- ]?12\b|marquee|\byes network|\bmsg\b|\bnesn\b|bally/],
  ['News', /news|\bcnn\b|msnbc|cnbc|bloomberg|al jazeera|france 24|euronews|fox business|newsmax|c-?span|weather|\bhln\b|\bnhk world\b|\bdw\b|\brt\b/],
  ['Music', /\bmtv|\bvh1\b|music|\bcmt\b|\bhits\b|\bradio\b|vevo|\bjams\b/],
  ['Documentary', /discovery|nat ?geo|national geographic|history|science|smithsonian|animal planet|\bdocu|viasat (explore|nature|history)|curiosity|\bpbs\b(?! kids)/],
  ['Movies', /\bhbo\b|cinemax|showtime|starz|\btcm\b|cinema|\bmovies?\b|\bfilm|\bepix\b|\bmgm\b|sundance|encore|\bflix|hallmark movies|\bcine\b/],
  ['Entertainment', /\bamc\b|\bfxx?\b|usa network|bravo|\be!|comedy|\btlc\b|a ?& ?e|hgtv|food|paramount|\btbs\b|\btnt\b|syfy|lifetime|oxygen|freeform|\bbet\b|\bifc\b|tv land|\bown\b|we ?tv|travel|entertainment|\bsky (one|atlantic|max)\b|\bitv\d?\b|\bbbc (one|two|three|four)\b|channel [45]|\bdave\b|\bgold\b/],
];

function categoryFrom(text: string, table: [Category, RegExp][]): Category | undefined {
  for (const [cat, re] of table) if (re.test(text)) return cat;
  return undefined;
}

// ---------------------------------------------------------------- countries

const ISO2 =
  'AD AE AF AG AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FO FR GA GB GD GE GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT ' +
  'JM JO JP KE KG KH KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MK ML MM MN MO MQ MR MT MU MV MW MX MY MZ NA NE NG ' +
  'NI NL NO NP NZ OM PA PE PF PG PH PK PL PR PS PT PY QA RE RO RS RU RW SA SC SE SG SI SK SL SM SN SO SR SV SY TD TG TH TJ TM TN TR TT TW TZ ' +
  'UA UG US UY UZ VA VE VN YE ZA ZM ZW UK';
// TV (Tuvalu) and SD (Sudan) are left out on purpose: in playlists they mean "TV" and standard definition.
const COUNTRY_ALIASES: Record<string, string> = {
  USA: 'US', GB: 'UK', GBR: 'UK', ENG: 'UK', CAN: 'CA', FRA: 'FR', GER: 'DE', DEU: 'DE', ESP: 'ES', ITA: 'IT', POR: 'PT', PRT: 'PT',
  BRA: 'BR', MEX: 'MX', ARG: 'AR', NED: 'NL', NLD: 'NL', TUR: 'TR', POL: 'PL', IND: 'IN', AUS: 'AU', IRL: 'IE', SWE: 'SE', NOR: 'NO',
  DEN: 'DK', BEL: 'BE', SUI: 'CH', AUT: 'AT', RUS: 'RU', GRE: 'GR', ROM: 'RO', KSA: 'SA', UAE: 'AE',
  LAT: 'LATINO', LATAM: 'LATINO', LATIN: 'LATINO', LATINO: 'LATINO', ARAB: 'ARAB', ARABIC: 'ARAB',
  AFR: 'AFRICA', AFRICA: 'AFRICA', EXYU: 'EXYU', 'EX-YU': 'EXYU', CARIB: 'CARIB', CARIBBEAN: 'CARIB',
};
const COUNTRY_SET = new Set(ISO2.split(' '));
const COUNTRY_WORDS: Record<string, string> = {
  'united states': 'US', usa: 'US', america: 'US', 'united kingdom': 'UK', england: 'UK', britain: 'UK', canada: 'CA', france: 'FR',
  germany: 'DE', deutschland: 'DE', spain: 'ES', 'españa': 'ES', espana: 'ES', italy: 'IT', italia: 'IT', portugal: 'PT', brazil: 'BR',
  brasil: 'BR', mexico: 'MX', 'méxico': 'MX', argentina: 'AR', netherlands: 'NL', holland: 'NL', turkey: 'TR', 'türkiye': 'TR',
  poland: 'PL', polska: 'PL', india: 'IN', latino: 'LATINO', latin: 'LATINO', arabic: 'ARAB', australia: 'AU', ireland: 'IE',
};
const COUNTRY_WORD_RE = new RegExp(`(?<![\\p{L}])(${Object.keys(COUNTRY_WORDS).join('|')})(?![\\p{L}])`, 'iu');

/** Canonical country code for a token, or undefined. */
export function countryCode(token: string): string | undefined {
  const t = token.toUpperCase();
  if (COUNTRY_ALIASES[t]) return COUNTRY_ALIASES[t];
  return COUNTRY_SET.has(t) ? t : undefined;
}

let regionNames: Intl.DisplayNames | null | undefined;
const SPECIAL_NAMES: Record<string, string> = { UK: 'United Kingdom', LATINO: 'Latino', ARAB: 'Arabic', AFRICA: 'Africa', EXYU: 'Ex-Yu', CARIB: 'Caribbean' };
/** Human name of a country code ("US" → "United States"). */
export function countryName(code?: string): string {
  if (!code) return 'International';
  if (SPECIAL_NAMES[code]) return SPECIAL_NAMES[code];
  if (regionNames === undefined) {
    try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { regionNames = null; }
  }
  try { return regionNames?.of(code) ?? code; } catch { return code; }
}

/** The user's country from the browser locale (e.g. en-US → US), default US. */
export function localeCountry(): string {
  try {
    const langs = typeof navigator !== 'undefined' ? [...(navigator.languages ?? []), navigator.language] : [];
    for (const l of langs) {
      const m = /[-_]([A-Za-z]{2})\b/.exec(l ?? '');
      if (m) return countryCode(m[1]) ?? 'US';
    }
  } catch { /* ignore */ }
  return 'US';
}

// ---------------------------------------------------------------- name cleaning

export interface Quality {
  /** Vertical resolution class: 2160, 1080, 720, 480, or 0 when the name has no tag. */
  res: number;
  hevc: boolean;
  backup: boolean;
}

export interface CleanName {
  name: string;
  country?: string;
  quality: Quality;
}

const SEP = '|:┃▎│•●★»\\-–—~';
// "US| ", "UK: ", "[CA] ", "|FR| ", "US - ", "(US) ", "4K| ", "VIP: "
const PREFIX_RE = new RegExp(
  `^\\s*[|┃▎│]?\\s*(?:\\[\\s*([A-Za-z0-9][A-Za-z0-9-]{0,7})\\s*\\]|\\(\\s*([A-Za-z0-9][A-Za-z0-9-]{0,7})\\s*\\)|([A-Za-z0-9][A-Za-z0-9-]{0,6})(?=\\s*[${SEP}]))\\s*[${SEP}]*\\s*`,
);
const FLAG_RE = /^\s*([\u{1F1E6}-\u{1F1FF}]{2})\s*[|:\-–]?\s*/u;
const SUFFIX_COUNTRY_RE = /\s*[[(]\s*([A-Za-z]{2,6})\s*[\])]\s*$/;
const QUALITY_RE =
  /(?<![A-Za-z0-9À-ɏ])(?:uhd|fhd|hd|4k|8k|2160[pi]?|1080[pi]|720[pi]|576[pi]|480[pi]|sd|hevc|h\.?26[45]|x26[45]|hdr(?:10)?|\d{2}\s?fps|vip|backup(?:\s*\d+)?|bkp\s*\d*|lq|hq|multi[- ]?audio)(?![A-Za-z0-9À-ɏ])/gi;
const BRACKET_ALT_RE = /[[(]\s*(?:alt|opt(?:ion)?|source|src|link|server|s|b)\s*-?\s*\d*\s*[\])]/gi;
const SUPERSCRIPT_RE = /[²³¹ʰ-˿ᴬ-ᵪᶛ-ᶿ⁰-₟]+/g;
const EMPTY_BR_RE = /[[(]\s*[\])]/g;
const SEP_TEST_RE = /[|┃▎│•●★»]/;
const SEP_RE = /\s*[|┃▎│•●★»]+\s*/g;
const MULTI_SPACE_RE = /\s{2,}/g;
const EDGE_RE = /^[\s\-–—:.,~]+|[\s\-–—:.,~]+$/g;
const JUNK_PREFIX = new Set(['VIP', 'HD', 'FHD', 'UHD', '4K', '8K', 'SD', 'HEVC', 'NEW', 'PREMIUM', 'RAW', '24/7']);

function resOf(tag: string): number {
  const t = tag.toLowerCase();
  if (/^(uhd|4k|8k|2160)/.test(t)) return 2160;
  if (/^(fhd|1080)/.test(t)) return 1080;
  if (/^(hd|720)/.test(t)) return 720;
  if (/^(sd|576|480|lq)/.test(t)) return 480;
  return 0;
}

const tagCache = new Map<string, Quality>();
/** What one quality tag ("FHD", "H.265", "Backup 2") says. */
function tagInfo(tag: string): Quality {
  let q = tagCache.get(tag);
  if (!q) {
    const t = tag.toLowerCase();
    q = { res: t === 'lq' ? 480 : resOf(t), hevc: /hevc|265/.test(t), backup: /^(backup|bkp)/.test(t) };
    tagCache.set(tag, q);
  }
  return q;
}

const cleanCache = new Map<string, CleanName>();

/**
 * Clean a raw playlist channel name: strip country/language prefixes, quality and variant tags,
 * and leftover separators. Returns the display name, the country code found in the name (if any)
 * and the quality detected from the tags.
 */
export function cleanChannelName(raw: string): CleanName {
  const hit = cleanCache.get(raw);
  if (hit) return hit;
  let s = raw;
  if (/[^\x00-\x7F]/.test(s)) {
    s = s.replace(SUPERSCRIPT_RE, (m) => ` ${m.normalize('NFKC')} `);
  }
  let country: string | undefined;
  const quality: Quality = { res: 0, hevc: false, backup: false };
  const flag = FLAG_RE.exec(s);
  if (flag) {
    const cps = [...flag[1]].map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0x1f1e6 + 65)).join('');
    country = countryCode(cps);
    s = s.slice(flag[0].length);
  }
  // Up to three stacked prefixes: "VIP| US: ESPN", "|US| 4K| ESPN".
  for (let i = 0; i < 3; i++) {
    const m = PREFIX_RE.exec(s);
    if (!m) break;
    const token = m[1] ?? m[2] ?? m[3];
    const bare = m[3] !== undefined;
    const up = token.toUpperCase();
    // Bare tokens must be upper case ("US|", not "Go:") to count as a prefix.
    if (bare && token !== up) break;
    const cc = countryCode(up);
    if (cc && !country) {
      country = cc;
    } else if (JUNK_PREFIX.has(up)) {
      const r = resOf(up);
      if (r) quality.res = Math.max(quality.res, r);
      if (up === 'HEVC') quality.hevc = true;
    } else break;
    const rest = s.slice(m[0].length);
    if (!rest.trim()) break;
    s = rest;
  }
  const last = s.charCodeAt(s.trimEnd().length - 1);
  const hasBr = s.includes('(') || s.includes('[');
  const suf = hasBr && (last === 41 || last === 93) ? SUFFIX_COUNTRY_RE.exec(s) : null;
  if (suf) {
    const cc = countryCode(suf[1]);
    if (cc && suf[1].length <= 3) {
      country ??= cc;
      s = s.slice(0, suf.index);
    }
  }
  if (hasBr && BRACKET_ALT_RE.test(s)) {
    quality.backup = true;
    s = s.replace(BRACKET_ALT_RE, ' ');
  }
  BRACKET_ALT_RE.lastIndex = 0;
  s = s.replace(QUALITY_RE, (tag) => {
    const q = tagInfo(tag);
    if (q.res > quality.res) quality.res = q.res;
    if (q.hevc) quality.hevc = true;
    if (q.backup) quality.backup = true;
    return ' ';
  });
  if (hasBr) s = s.replace(EMPTY_BR_RE, ' '); // empty brackets left by removed tags
  if (SEP_TEST_RE.test(s)) s = s.replace(SEP_RE, ' ');
  let name = s.replace(MULTI_SPACE_RE, ' ').replace(EDGE_RE, '');
  if (!name) name = raw.trim();
  const out = { name, country, quality };
  if (cleanCache.size > 200_000) cleanCache.clear();
  cleanCache.set(raw, out);
  return out;
}

/** Short label for a quality ("4K", "FHD", "HD", "SD", "" when unknown). */
export function qualityLabel(q: Quality): string {
  let out = q.res >= 2160 ? '4K' : q.res >= 1080 ? 'FHD' : q.res >= 720 ? 'HD' : q.res > 0 ? 'SD' : '';
  if (q.hevc) out = out ? `${out} HEVC` : 'HEVC';
  if (q.backup) out = out ? `${out} Backup` : 'Backup';
  return out;
}

/** Variant label for menus: never empty. */
export function variantLabel(q: Quality, index: number): string {
  void index;
  return qualityLabel(q) || 'Standard';
}

export type MaxRes = 'auto' | '2160' | '1080' | '720' | '480';
const RES_ORDER: Record<MaxRes, number[]> = {
  // Default: FHD/HD first (bandwidth), untagged next, 4K after, SD last.
  auto: [1080, 720, 0, 2160, 480],
  '2160': [2160, 1080, 720, 0, 480],
  '1080': [1080, 720, 0, 480, 2160],
  '720': [720, 0, 480, 1080, 2160],
  '480': [480, 0, 720, 1080, 2160],
};

/** Lower is better. Backups go last; HEVC loses ties (not every machine decodes it). */
export function qualityScore(q: Quality, maxRes: MaxRes = 'auto'): number {
  const order = RES_ORDER[maxRes] ?? RES_ORDER.auto;
  const i = order.indexOf(q.res);
  return (q.backup ? 100 : 0) + (i < 0 ? order.length : i) * 10 + (q.hevc ? 1 : 0);
}

/** Key for comparing names: lower case letters/digits only. */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/&/g, 'and').replace(/\+/g, 'plus').replace(/[^\p{L}\p{N}]+/gu, '');
}

const WORD_RE = /[A-Za-z0-9]+/g;
function markFor(name: string) {
  WORD_RE.lastIndex = 0;
  const a = WORD_RE.exec(name);
  if (!a) return name.slice(0, 2).toUpperCase() || '??';
  const b = WORD_RE.exec(name);
  return (b ? a[0][0] + b[0][0] : a[0].slice(0, 2)).toUpperCase();
}

// ---------------------------------------------------------------- groups

export interface ParsedGroup {
  country?: string;
  /** Category derived from the group text (undefined when the group says nothing useful). */
  category?: Category;
}

const groupCache = new Map<string, ParsedGroup>();

/** Split a messy provider group ("US| SPORTS", "UK - Sports", "[CA] News", "FR: Movies") into country + category. */
export function parseGroup(raw: string): ParsedGroup {
  const hit = groupCache.get(raw);
  if (hit) return hit;
  let s = raw.trim();
  let country: string | undefined;
  const flag = FLAG_RE.exec(s);
  if (flag) {
    country = countryCode([...flag[1]].map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0x1f1e6 + 65)).join(''));
    s = s.slice(flag[0].length);
  }
  if (!country) {
    const m = PREFIX_RE.exec(s);
    const token = m && (m[1] ?? m[2] ?? m[3]);
    const cc = token && (m[3] === undefined || token === token.toUpperCase()) ? countryCode(token) : undefined;
    if (cc) {
      country = cc;
      s = s.slice(m![0].length);
    } else {
      // "USA SPORTS", "UK ENTERTAINMENT": an upper-case code followed by a space.
      const b = /^([A-Z]{2,3})\s+(\S.*)$/.exec(s);
      const bc = b ? countryCode(b[1]) : undefined;
      if (bc) {
        country = bc;
        s = b![2];
      } else {
        const suf = SUFFIX_COUNTRY_RE.exec(s);
        const sc = suf ? countryCode(suf[1]) : undefined;
        if (sc) {
          country = sc;
          s = s.slice(0, suf!.index);
        } else {
          const w = COUNTRY_WORD_RE.exec(s);
          if (w) country = COUNTRY_WORDS[w[1].toLowerCase()];
        }
      }
    }
  }
  const category = categoryFrom(s.toLowerCase(), GROUP_CAT);
  const out = { country, category };
  if (groupCache.size > 50_000) groupCache.clear();
  groupCache.set(raw, out);
  return out;
}

/** Category of a channel from its (clean) name, when the group doesn't say. */
const LOCAL_NET_RE = /^(abc|cbs|nbc|fox|cw|my ?network|ion|telemundo|univision|unimas|ctv|citytv)\b/i;
/** US call signs (WNYW, KTLA-DT): upper case only, checked on the original name. */
const CALL_SIGN_RE = /(?<![A-Za-z])[KW][A-Z]{2,3}(-(TV|DT|LD|CD))?(?![A-Za-z])/;
const NAME_CAT_MAIN = NAME_CAT.filter(([c]) => c !== 'Entertainment');
const NAME_CAT_ENT = NAME_CAT.filter(([c]) => c === 'Entertainment');

export function categoryFromName(name: string): Category | undefined {
  const lower = name.toLowerCase();
  // Specific categories first, so "FOX News" / "CBS Sports" don't count as locals.
  return categoryFrom(lower, NAME_CAT_MAIN)
    ?? (LOCAL_NET_RE.test(name) || CALL_SIGN_RE.test(name) ? 'Locals' : undefined)
    ?? categoryFrom(lower, NAME_CAT_ENT);
}

export const groupKeyOf = (country: string | undefined, category: Category) => `${country ?? ''}|${category}`;

export function defaultGroupLabel(country: string | undefined, category: Category) {
  return country ? `${country} · ${category}` : category;
}

// ---------------------------------------------------------------- organize

export interface Variant {
  id: string;
  url: string;
  label: string;
  quality: Quality;
  rawName: string;
  fallbackUrls?: string[];
}

/** A logical channel: one per real channel, with its quality variants. */
export interface OrgChannel extends Channel {
  /** Clean name, without country/quality tags. `name` is the same, plus "(CC)" when the clean name exists in several countries. */
  displayName: string;
  /** The playlist's original name of the channel's id entry (EPG / broadcast matching). */
  rawName: string;
  rawGroup: string;
  country?: string;
  category: Category;
  groupKey: string;
  quality: Quality;
  qualityLabel: string;
  /** Quality variants, best first by the user's settings (length 1 when not merged). */
  variants: Variant[];
  /** Raw playlist ids folded into this channel (aliases for favorites, tuning from score cards...). */
  memberIds: string[];
}

export interface GroupInfo {
  key: string;
  country?: string;
  category: Category;
  label: string;
  /** Logical channels in the group. */
  count: number;
  /** First appearance in the playlist (default order). */
  first: number;
}

export interface Organized {
  /** All live logical channels, in playlist order. */
  all: OrgChannel[];
  byId: Map<string, OrgChannel>;
  /** Groups in default order: home country first, then by first appearance. */
  groups: GroupInfo[];
  /** Raw channel id → logical channel id. */
  alias: Map<string, string>;
  countries: { code?: string; count: number }[];
  /** Live playlist entries before merging. */
  rawCount: number;
}

export interface OrganizeOptions {
  merge: boolean;
  maxRes: MaxRes;
  homeCountry?: string;
}

interface Parsed {
  clean: CleanName;
  key: string;
  country?: string;
  category: Category;
}

const parsedCache = new WeakMap<Channel, Parsed>();

function parseEntry(c: Channel): Parsed {
  let p = parsedCache.get(c);
  if (p) return p;
  const clean = cleanChannelName(c.name);
  const g = parseGroup(c.group ?? '');
  let country = clean.country ?? g.country;
  if (!country && c.tvgId) {
    const m = /\.([a-z]{2})$/i.exec(c.tvgId);
    if (m) country = countryCode(m[1]);
  }
  const category = g.category ?? categoryFromName(clean.name) ?? 'Other';
  p = { clean, key: nameKey(clean.name), country, category };
  parsedCache.set(c, p);
  return p;
}

const isLiveCh = (c: Channel) => !c.kind || c.kind === 'live';

const orgCache = new WeakMap<Channel[], Map<string, Organized>>();

/** Organize live channels (memoized per channels array + options). */
export function organize(channels: Channel[], opts: OrganizeOptions): Organized {
  const optKey = `${opts.merge ? 1 : 0}|${opts.maxRes}|${opts.homeCountry ?? ''}`;
  let per = orgCache.get(channels);
  const hit = per?.get(optKey);
  if (hit) return hit;
  const out = organizeNow(channels, opts);
  if (!per) orgCache.set(channels, (per = new Map()));
  per.set(optKey, out);
  return out;
}

function organizeNow(channels: Channel[], opts: OrganizeOptions): Organized {
  const live = channels.filter(isLiveCh);
  // Buckets of raw entries that are the same channel.
  const buckets: Channel[][] = [];
  if (opts.merge) {
    // One pass in playlist order, so buckets and their members keep the playlist order.
    // Same tvg-id AND same clean name (+ source + country) merge: providers often give every local
    // affiliate the same EPG id, so the name guard keeps "ABC New York" and "ABC Chicago" apart.
    // Entries without a tvg-id join a bucket with the same clean name + country.
    const byFull = new Map<string, Channel[]>();
    const byName = new Map<string, { b: Channel[]; tvg: boolean }>();
    for (const c of live) {
      const p = parseEntry(c);
      const nk = c.sourceId + '\u0001' + (p.country ?? '') + '\u0001' + p.key;
      if (c.tvgId) {
        const fk = nk + '\u0001' + c.tvgId.toLowerCase();
        let b = byFull.get(fk);
        if (!b) {
          const named = byName.get(nk);
          if (named && !named.tvg) {
            // Earlier tvg-less copies of this channel: adopt them.
            named.tvg = true;
            b = named.b;
          } else {
            b = [];
            buckets.push(b);
            if (!named) byName.set(nk, { b, tvg: true });
          }
          byFull.set(fk, b);
        }
        b.push(c);
      } else {
        let named = byName.get(nk);
        if (!named) {
          named = { b: [], tvg: false };
          byName.set(nk, named);
          buckets.push(named.b);
        }
        named.b.push(c);
      }
    }
  } else {
    for (const c of live) buckets.push([c]);
  }

  const all: OrgChannel[] = [];
  const alias = new Map<string, string>();
  const groups = new Map<string, GroupInfo>();
  const nameCountry = new Map<string, string>(); // clean name → first country seen
  const multiCountry = new Set<string>(); // clean names found in several countries

  for (const b of buckets) {
    // id entry: the first with a tvg-id (guide listings resolve through it), else the first.
    const canon = b.find((c) => c.tvgId) ?? b[0];
    const pc = parseEntry(canon);
    let variants: Variant[];
    let primary: Channel;
    if (b.length === 1) {
      primary = canon;
      variants = [{ id: canon.id, url: canon.url, label: variantLabel(pc.clean.quality, 0), quality: pc.clean.quality, rawName: canon.name, fallbackUrls: canon.fallbackUrls }];
    } else {
      const ranked = b
        .map((c, i) => ({ c, i, q: parseEntry(c).clean.quality }))
        .sort((x, y) => qualityScore(x.q, opts.maxRes) - qualityScore(y.q, opts.maxRes) || x.i - y.i);
      primary = ranked[0].c;
      variants = ranked.map(({ c, q }, i) => ({ id: c.id, url: c.url, label: variantLabel(q, i), quality: q, rawName: c.name, fallbackUrls: c.fallbackUrls }));
      // Two variants with the same label: number them ("FHD", "FHD 2").
      const seen = new Map<string, number>();
      for (const v of variants) {
        const n = (seen.get(v.label) ?? 0) + 1;
        seen.set(v.label, n);
        if (n > 1) v.label = `${v.label} ${n}`;
      }
    }
    const country = pc.country;
    const category = pc.category;
    const groupKey = groupKeyOf(country, category);
    const display = pc.clean.name;
    const ch: OrgChannel = {
      ...canon,
      url: primary.url,
      fallbackUrls: fallbacksFor(variants, 0),
      userAgent: primary.userAgent ?? canon.userAgent,
      referrer: primary.referrer ?? canon.referrer,
      headers: primary.headers ?? canon.headers,
      logo: canon.logo || b.find((c) => c.logo)?.logo,
      tvgId: canon.tvgId,
      name: display,
      displayName: display,
      rawName: canon.name,
      rawGroup: canon.group,
      mark: markFor(display),
      country,
      category,
      groupKey,
      group: defaultGroupLabel(country, category),
      quality: variants[0].quality,
      qualityLabel: qualityLabel(variants[0].quality),
      variants,
      memberIds: b.map((c) => c.id),
    };
    all.push(ch);
    for (const c of b) alias.set(c.id, ch.id);
    let g = groups.get(groupKey);
    if (!g) groups.set(groupKey, (g = { key: groupKey, country, category, label: defaultGroupLabel(country, category), count: 0, first: all.length - 1 }));
    g.count++;
    const k = display.toLowerCase();
    const first = nameCountry.get(k);
    if (first === undefined) nameCountry.set(k, country ?? '');
    else if (first !== (country ?? '')) multiCountry.add(k);
  }

  // "ESPN" from the US and from the UK: say which is which in lists that only show `name`.
  for (const ch of all) {
    if (ch.country && multiCountry.size && multiCountry.has(ch.displayName.toLowerCase())) ch.name = `${ch.displayName} (${ch.country})`;
  }

  const home = opts.homeCountry;
  const countryFirst = new Map<string, number>();
  for (const g of groups.values()) {
    const c = g.country ?? '';
    if (!countryFirst.has(c) || countryFirst.get(c)! > g.first) countryFirst.set(c, g.first);
  }
  const rank = (g: GroupInfo) => (home && g.country === home ? -1 : countryFirst.get(g.country ?? '')!);
  const groupList = [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.first - b.first);

  const cc = new Map<string, number>();
  for (const ch of all) cc.set(ch.country ?? '', (cc.get(ch.country ?? '') ?? 0) + 1);
  const countries = [...cc.entries()]
    .map(([code, count]) => ({ code: code || undefined, count }))
    .sort((a, b) => b.count - a.count);

  return { all, byId: new Map(all.map((c) => [c.id, c])), groups: groupList, alias, countries, rawCount: live.length };
}

/** Fallback URLs when variant `primary` plays: the other variants in preference order, then each one's own backups. */
export function fallbacksFor(variants: Variant[], primary: number): string[] | undefined {
  if (variants.length === 1) return variants[0].fallbackUrls?.length ? [...variants[0].fallbackUrls] : undefined;
  const urls: string[] = [];
  const seen = new Set<string>([variants[primary].url]);
  const add = (u: string) => { if (!seen.has(u)) { seen.add(u); urls.push(u); } };
  for (const u of variants[primary].fallbackUrls ?? []) add(u);
  variants.forEach((v, i) => { if (i !== primary) add(v.url); });
  variants.forEach((v, i) => { if (i !== primary) for (const u of v.fallbackUrls ?? []) add(u); });
  return urls.length ? urls : undefined;
}

// ---------------------------------------------------------------- user preferences

export interface OrgPrefs {
  hiddenGroups: string[];
  groupOrder: string[];
  groupNames: Record<string, string>;
  variantChoice: Record<string, string>;
  renumber: boolean;
}

export interface ApplyContext {
  channelOrder: string[];
  hidden: string[];
  includeHidden?: boolean;
}

/** Groups in the user's order (saved order first, then the default order). */
export function orderGroups(org: Organized, prefs: Pick<OrgPrefs, 'groupOrder'>): GroupInfo[] {
  if (!prefs.groupOrder.length) return org.groups;
  const idx = new Map(prefs.groupOrder.map((k, i) => [k, i]));
  const def = new Map(org.groups.map((g, i) => [g.key, i]));
  return [...org.groups].sort((a, b) => (idx.get(a.key) ?? 1e6 + def.get(a.key)!) - (idx.get(b.key) ?? 1e6 + def.get(b.key)!));
}

/**
 * Apply the user's organization: hidden groups/channels, group order, custom channel order,
 * renamed groups, chosen quality variants and optional renumbering (1, 2, 3… in visible order).
 */
export function applyPrefs(org: Organized, prefs: OrgPrefs, ctx: ApplyContext): OrgChannel[] {
  const groupsOrdered = orderGroups(org, prefs);
  const gRank = new Map(groupsOrdered.map((g, i) => [g.key, i]));
  const chIdx = new Map(ctx.channelOrder.map((id, i) => [id, i]));
  const hidden = new Set(ctx.hidden);
  const hiddenGroups = new Set(prefs.hiddenGroups);
  const sorted = org.all
    .map((c, i) => ({ c, i, g: gRank.get(c.groupKey) ?? 1e6, o: chIdx.get(c.id) ?? 1e6 + c.number }))
    .sort((a, b) => a.g - b.g || a.o - b.o || a.i - b.i);
  const out: OrgChannel[] = [];
  let n = 0;
  for (const { c } of sorted) {
    const isHidden = hidden.has(c.id) || hiddenGroups.has(c.groupKey);
    if (isHidden && !ctx.includeHidden) continue;
    let ch = c;
    // Variants the user hid individually (e.g. a 4K copy) are dropped from the merge.
    if (c.variants.length > 1 && hidden.size && c.variants.some((v) => v.id !== c.id && hidden.has(v.id))) {
      const variants = c.variants.filter((v) => v.id === c.id || !hidden.has(v.id));
      ch = { ...c, variants, url: variants[0].url, fallbackUrls: fallbacksFor(variants, 0), quality: variants[0].quality, qualityLabel: qualityLabel(variants[0].quality) };
    }
    const choice = prefs.variantChoice[c.id];
    if (choice && ch.variants.length > 1 && ch.variants[0].id !== choice) {
      const vi = ch.variants.findIndex((v) => v.id === choice);
      if (vi > 0) {
        const v = ch.variants[vi];
        ch = { ...ch, url: v.url, fallbackUrls: fallbacksFor(ch.variants, vi), quality: v.quality, qualityLabel: qualityLabel(v.quality) };
      }
    }
    const label = prefs.groupNames[c.groupKey];
    const number = prefs.renumber && !isHidden ? ++n : c.number;
    if ((label && label !== ch.group) || number !== ch.number) ch = { ...ch, group: label || ch.group, number };
    out.push(ch);
  }
  return out;
}

/** Index of the variant that plays for a channel (after the user's choice). */
export function activeVariant(ch: OrgChannel): number {
  const i = ch.variants.findIndex((v) => v.url === ch.url);
  return i < 0 ? 0 : i;
}

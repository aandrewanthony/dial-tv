/**
 * Which sport a channel is about, for the Sports section of the Live TV rail.
 *  - By name/group (static): "NFL Network" → football, "beIN Sports" → soccer, "SEC Network" → college.
 *    Sports-category channels that name no sport ("ESPN", "FS1", "TSN 2") are "Sports networks".
 *  - By what's on now (live): the guide programme ("NFL Football", "Premier League") or a live game
 *    matched to the channel's broadcast (CBS during an NFL game counts as football right now).
 */
import type { League } from '../types';

export type SportKey =
  | 'football' | 'basketball' | 'baseball' | 'hockey' | 'soccer' | 'college' | 'tennis' | 'golf'
  | 'fighting' | 'wrestling' | 'motor' | 'horse' | 'rugby' | 'cricket' | 'olympics' | 'networks';

export const SPORTS: { key: SportKey; label: string; icon: string }[] = [
  { key: 'football', label: 'Football', icon: '🏈' },
  { key: 'basketball', label: 'Basketball', icon: '🏀' },
  { key: 'baseball', label: 'Baseball', icon: '⚾' },
  { key: 'hockey', label: 'Hockey', icon: '🏒' },
  { key: 'soccer', label: 'Soccer', icon: '⚽' },
  { key: 'college', label: 'College', icon: '🎓' },
  { key: 'tennis', label: 'Tennis', icon: '🎾' },
  { key: 'golf', label: 'Golf', icon: '⛳' },
  { key: 'fighting', label: 'Boxing & MMA', icon: '🥊' },
  { key: 'wrestling', label: 'Wrestling', icon: '🤼' },
  { key: 'motor', label: 'Motorsports', icon: '🏎️' },
  { key: 'horse', label: 'Horse racing', icon: '🏇' },
  { key: 'rugby', label: 'Rugby', icon: '🏉' },
  { key: 'cricket', label: 'Cricket', icon: '🏏' },
  { key: 'olympics', label: 'Olympics', icon: '🏅' },
  { key: 'networks', label: 'Sports networks', icon: '📺' },
];

export const sportInfo = (k: SportKey) => SPORTS.find((s) => s.key === k)!;

// Order matters only for the single-sport title match (first hit wins); names can match several.
const RULES: [SportKey, RegExp][] = [
  ['horse', /\btvg\b|horse|equestrian|racing uk|sky sports racing|fanduel racing|at the races|racetrack|\bpremier racing/],
  ['football', /\bnfl\b|red ?zone|sunday ticket|\bcfl\b|\bxfl\b|\bufl\b|american football|\bncaaf\b|college football|monday night football|thursday night football|sunday night football/],
  ['basketball', /\bnba\b|\bwnba\b|basketball|\bncaab\b|\bncaam\b|march madness|league pass|euroleague|\bg league\b/],
  ['baseball', /\bmlb\b|baseball|extra innings|\bmilb\b|world series/],
  ['hockey', /\bnhl\b|hockey|center ice|\bkhl\b|\bahl\b|stanley cup/],
  ['soccer', /soccer|f[uú]tbol|futebol|premier league|\bepl\b|la ?liga|serie a\b|bundesliga|ligue 1|champions league|europa league|\bucl\b|\bmls\b|\bbein\b|\btudn\b|deportes|\bfifa\b|\buefa\b|eredivisie|liga mx|\bcopa\b|golazo|gol ?tv|\bspfl\b|\befl\b|\bfa cup\b|world cup|calcio/],
  ['college', /\bb1g\b|sec network|\bsecn\b|acc network|\baccn\b|big ten|\bbtn\b|pac[- ]?12|longhorn network|\bespnu\b|\bncaa\b|college/],
  ['tennis', /tennis|\bwta\b|\batp\b|wimbledon|roland garros|us open tennis/],
  ['golf', /golf|\bpga\b|\blpga\b|\bliv\b|masters tournament|ryder cup/],
  ['fighting', /\bufc\b|boxing|\bmma\b|bellator|\bpfl\b|fight|top rank|\bpbc\b|\bppv\b/],
  ['wrestling', /\bwwe\b|\baew\b|wrestling|\btna\b|\broh\b|\bnjpw\b|smackdown|\braw\b/],
  ['motor', /\bf1\b|formula ?1|formula one|nascar|motogp|indycar|motorsports?|motor sports?|\bspeed\b|racing|rally|\bimsa\b|supercross/],
  ['rugby', /rugby|\bnrl\b|super league/],
  ['cricket', /cricket|willow|\bipl\b|\bbbl\b|\bt20\b/],
  ['olympics', /olympic|paralympic/],
];

const NOT_US = /^(?!US$|CA$)/;

const nameCache = new Map<string, SportKey[]>();

/** Sports a channel covers by its name and provider group. `country` resolves "Football" (soccer outside US/CA). */
export function sportsOfName(name: string, group = '', country?: string): SportKey[] {
  const key = `${name}\u0000${group}\u0000${country ?? ''}`;
  const hit = nameCache.get(key);
  if (hit) return hit;
  const text = `${name} ${group}`.toLowerCase();
  const out: SportKey[] = [];
  for (const [k, re] of RULES) if (re.test(text)) out.push(k);
  // A plain "Football" outside the US and Canada is soccer.
  if (!out.length && /\bfootball\b/.test(text)) out.push(country && NOT_US.test(country) ? 'soccer' : 'football');
  // "Horse racing" is not motorsport.
  const res = out.includes('horse') ? out.filter((k) => k !== 'motor') : out;
  if (nameCache.size > 100_000) nameCache.clear();
  nameCache.set(key, res);
  return res;
}

/** The sport of a guide programme ("NFL Football", "MLS Soccer"), if it's a game/event. */
export function sportOfProgram(title: string, category = '', country?: string): SportKey | undefined {
  const text = `${title} ${category}`.toLowerCase();
  if (/college football|ncaa football|\bncaaf\b/.test(text)) return 'football';
  if (/college basketball|ncaa basketball|\bncaab\b|\bncaam\b/.test(text)) return 'basketball';
  for (const [k, re] of RULES) {
    // Programme titles: skip the network-ish rules that would mislabel shows ("Raw" talk shows, "College GameDay").
    if (k === 'college' || k === 'networks') continue;
    if (re.test(text)) return k;
  }
  if (/\bfootball\b/.test(text)) return country && NOT_US.test(country) ? 'soccer' : 'football';
  return undefined;
}

export function sportOfLeague(l: League): SportKey {
  switch (l) {
    case 'nfl': case 'ncaaf': return 'football';
    case 'nba': case 'wnba': case 'ncaam': return 'basketball';
    case 'mlb': return 'baseball';
    case 'nhl': return 'hockey';
    default: return 'soccer';
  }
}

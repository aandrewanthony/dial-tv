/**
 * Which channel is a game really on? ESPN only names networks ("FOX", "ESPN+"), and matching by
 * network alone lands on any local affiliate or the wrong numbered feed. This looks at the actual
 * schedule first:
 *  1. Event feeds: numbered provider feeds are renamed for what they carry
 *     ("NFL 03: Lions vs Bears", "ESPN+ 111: Michigan @ Ohio State"): a channel naming both teams wins.
 *  2. The TV guide: a programme around game time whose title / episode / description names both
 *     teams ("NFL Football — Detroit Lions at Chicago Bears"); among several, one on a listed network
 *     is preferred.
 *  3. Otherwise the caller falls back to the network name (lib/channelMatch.ts).
 * Games are registered by their `broadcasts` array (providers/espn.ts), so every existing
 * matchBroadcasts(g.broadcasts, …) call gets this without changes.
 */
import type { Channel, Program, SportEvent, Team } from '../types';

const gameOf = new WeakMap<string[], SportEvent>();
export const registerGame = (g: SportEvent) => { gameOf.set(g.broadcasts, g); };
export const gameForBroadcasts = (b: string[]) => gameOf.get(b);

/** Guide access, injected by the app (avoids importing the store here): channel id → programmes sorted by start. */
let guide: () => Map<string, Program[]> = () => new Map();
export const setGuideAccess = (fn: () => Map<string, Program[]>) => { guide = fn; };

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const GENERIC = new Set(['state', 'city', 'united', 'real', 'club', 'new', 'san', 'los', 'saint', 'st', 'north', 'south', 'east', 'west', 'the', 'university', 'college', 'tech', 'fc', 'sc', 'of']);

/** Ways a team is written: "lions", "detroit", "detroit lions" (words of 4+ letters, no generic ones alone). */
function teamKeys(t: Team): string[] {
  const full = norm(t.name);
  const nick = norm(t.shortName);
  const loc = nick && full.endsWith(nick) ? full.slice(0, full.length - nick.length).trim() : '';
  const keys = new Set<string>();
  for (const k of [full, nick, loc]) {
    if (k.length >= 4 && !(GENERIC.has(k))) keys.add(k);
  }
  return [...keys];
}

const cache = new WeakMap<Team, string[]>();
const keysOf = (t: Team) => { let k = cache.get(t); if (!k) cache.set(t, (k = teamKeys(t))); return k; };
const mentions = (text: string, t: Team) => keysOf(t).some((k) => text.includes(` ${k} `));

/** Does this text (channel name, programme title…) name both teams of the game? */
export function namesGame(text: string, g: Pick<SportEvent, 'home' | 'away'>): boolean {
  const s = ` ${norm(text)} `;
  return mentions(s, g.home) && mentions(s, g.away);
}

/** A numbered provider feed with nothing on it right now: ":Milb  06", "ESPN+ 111:", "NHL | 06", "NBA 06 :". */
export function isIdleFeed(name: string): boolean {
  const m = /^(:?)\s*[A-Za-z][A-Za-z0-9+ .]{1,16}?\s*(\|?)\s*(\d{1,3})\s*([:|]?)\s*$/.exec(name.trim());
  if (!m) return false;
  const [, lead, bar, num, trail] = m;
  return !!lead || !!bar || !!trail || num.length >= 2 || +num >= 6;
}

export interface ScheduleMatch { channel: Channel; via: 'event' | 'guide' }

const memo = new Map<string, { at: number; channels: Channel[]; programs: Map<string, Program[]>; hit: ScheduleMatch | null }>();
const TTL = 5 * 60_000;

/** The channel the schedule says carries this game, if any (see the file comment). Cached for 5 minutes. */
export function scheduleMatch(g: SportEvent, channels: Channel[], prefer: (c: Channel) => boolean = () => false): ScheduleMatch | null {
  const programs = guide();
  const now = Date.now();
  const m = memo.get(g.id);
  if (m && now - m.at < TTL && m.channels === channels && m.programs === programs) return m.hit;
  const hit = compute(g, channels, programs, now, prefer);
  if (memo.size > 2000) memo.clear();
  memo.set(g.id, { at: now, channels, programs, hit });
  return hit;
}

function compute(g: SportEvent, channels: Channel[], programs: Map<string, Program[]>, now: number, prefer: (c: Channel) => boolean): ScheduleMatch | null {
  if (!keysOf(g.home).length || !keysOf(g.away).length) return null;
  const live = channels.filter((c) => !c.kind || c.kind === 'live');
  // 1. Event feeds are named for what's on now / next: only trust them close to game time.
  if (g.state === 'in' || Math.abs(g.start - now) < 8 * 3600_000) {
    const named = live.filter((c) => namesGame(c.name, g));
    if (named.length) return { channel: named.find(prefer) ?? named[0], via: 'event' };
  }
  // 2. The guide, around kickoff (or right now for a live game).
  if (!programs.size) return null;
  const from = g.state === 'in' ? now - 60_000 : g.start - 10 * 60_000;
  const to = g.state === 'in' ? now + 60_000 : g.start + 45 * 60_000;
  const byId = new Map(live.map((c) => [c.id, c]));
  const found: Channel[] = [];
  for (const [id, list] of programs) {
    const ch = byId.get(id);
    if (!ch) continue;
    // Lists are sorted by start: find programmes overlapping [from, to).
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].end <= from) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < list.length && list[i].start < to; i++) {
      const p = list[i];
      if (namesGame(`${p.title} ${p.subtitle ?? ''} ${p.description ?? ''}`, g)) { found.push(ch); break; }
    }
  }
  if (!found.length) return null;
  return { channel: found.find(prefer) ?? found[0], via: 'guide' };
}

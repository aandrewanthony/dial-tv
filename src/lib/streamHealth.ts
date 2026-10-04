/**
 * Dead-channel detection (Settings → Channels → Hide dead channels): the pure part.
 *
 * Health is kept per stream URL, keyed by a hash of the URL (stream links can carry provider
 * logins, so the URL itself is never stored). A URL is dead after two failed checks at least
 * six hours apart with no success in between; any later success revives it. A logical channel
 * (merged duplicates) is dead only when every URL of every variant is dead; otherwise its
 * working variants are ordered first.
 */
import { activeVariant, fallbacksFor, qualityLabel, type OrgChannel, type Variant } from './channelOrg';
import { engineFromBytes } from '../player/detect';
import { channelHeaders, desktop, isDesktop } from './net';
import { isHttpUrl, splitUserinfo } from './url';

export const HOUR = 3_600_000;
/** Two failures at least this far apart make a URL dead. */
export const DEAD_GAP = 6 * HOUR;
/** A dead URL is tried again after this long (a success revives it). */
export const DEAD_RECHECK = 24 * HOUR;
/** A working URL is checked again after this long. */
export const OK_RECHECK = 3 * 24 * HOUR;
/** A check that gave no answer (blocked, account trouble) is retried after this long. */
export const SKIP_RECHECK = 24 * HOUR;
/** Never check the same URL twice within this (except a manual re-check). */
export const MIN_GAP = 30 * 60_000;

export interface UrlHealth {
  /** Failed checks since the last success. */
  fails: number;
  firstFail?: number;
  lastFail?: number;
  lastOk?: number;
  /** Last check of any outcome (including "no answer"). */
  lastCheck?: number;
  /** Last "no answer" (CORS, 401, rate limit...). */
  skipAt?: number;
  /** Why the last check failed ("HTTP 404", "timeout", "not a stream"). */
  why?: string;
}

/** cyrb53: a fast 53-bit string hash, as hex. Only used as a storage key. */
export function urlKey(url: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < url.length; i++) {
    const ch = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function isDeadHealth(h: UrlHealth | undefined): boolean {
  return !!h && h.fails >= 2 && h.firstFail !== undefined && h.lastFail !== undefined && h.lastFail - h.firstFail >= DEAD_GAP;
}

/** Health after a check: 'ok' resets, 'fail' extends the failure streak, 'skip' only notes the attempt. */
export function withResult(h: UrlHealth | undefined, result: 'ok' | 'fail' | 'skip', now: number, why?: string): UrlHealth {
  const prev: UrlHealth = h ?? { fails: 0 };
  if (result === 'ok') return { fails: 0, lastOk: now, lastCheck: now };
  if (result === 'skip') return { ...prev, lastCheck: now, skipAt: now };
  return { ...prev, fails: prev.fails + 1, firstFail: prev.fails ? prev.firstFail ?? now : now, lastFail: now, lastCheck: now, why };
}

/**
 * When a URL should be checked next by the background checker, and how urgent it is
 * (lower tier first): 0 = confirm a failure, 1 = never checked, 2 = dead (revival), 3 = working (refresh).
 */
export function dueInfo(h: UrlHealth | undefined): { at: number; tier: number } {
  if (!h) return { at: 0, tier: 1 };
  const gap = (h.lastCheck ?? 0) + MIN_GAP;
  if (isDeadHealth(h)) return { at: Math.max(gap, (h.lastFail ?? 0) + DEAD_RECHECK), tier: 2 };
  if (h.fails > 0) return { at: Math.max(gap, (h.lastFail ?? 0) + DEAD_GAP), tier: 0 };
  if (h.lastOk) return { at: Math.max(gap, h.lastOk + OK_RECHECK, h.skipAt ? h.skipAt + SKIP_RECHECK : 0), tier: 3 };
  return { at: Math.max(gap, (h.skipAt ?? 0) + SKIP_RECHECK), tier: 1 };
}

export type HealthMap = Record<string, UrlHealth>;

const urlDead = (health: HealthMap, u: string) => isDeadHealth(health[urlKey(u)]);

/** A variant's URLs: its own link, then the playlist's backups for it. */
export const variantUrls = (v: Variant) => [v.url, ...(v.fallbackUrls ?? [])];

/** Every URL of a logical channel, in the order they're worth checking (variant order). */
export function channelUrls(c: OrgChannel): string[] {
  const out: string[] = [];
  for (const v of c.variants) for (const u of variantUrls(v)) if (!out.includes(u)) out.push(u);
  if (!out.includes(c.url)) out.unshift(c.url);
  return out;
}

/** Dead = every URL of every variant is dead. */
export function isChannelDead(c: OrgChannel, health: HealthMap): boolean {
  const urls = channelUrls(c);
  return urls.length > 0 && urls.every((u) => urlDead(health, u));
}

/**
 * Apply dead-channel state to an ordered lineup: drop dead channels (when `hide`, unless kept),
 * and move working variants / backup links ahead of dead ones. A variant that is playing by the
 * user's choice and still works stays the one that plays.
 */
export function applyHealth(list: OrgChannel[], health: HealthMap, keep: Set<string>, hide: boolean): OrgChannel[] {
  const out: OrgChannel[] = [];
  for (const c of list) {
    if (isChannelDead(c, health)) {
      if (hide && !keep.has(c.id)) continue;
      out.push(c);
      continue;
    }
    out.push(reorderVariants(c, health));
  }
  return out;
}

function reorderVariants(c: OrgChannel, health: HealthMap): OrgChannel {
  let changed = false;
  const active = activeVariant(c);
  // Inside each variant: working links first.
  const vs = c.variants.map((v) => {
    const urls = variantUrls(v);
    if (urls.length < 2 || !urls.some((u) => urlDead(health, u))) return v;
    const sorted = [...urls.filter((u) => !urlDead(health, u)), ...urls.filter((u) => urlDead(health, u))];
    if (sorted[0] === v.url) return v;
    changed = true;
    return { ...v, url: sorted[0], fallbackUrls: sorted.slice(1) };
  });
  const dead = vs.map((v) => variantUrls(v).every((u) => urlDead(health, u)));
  if (!changed && !dead.some(Boolean)) return c;
  const order = vs.map((v, i) => i).sort((a, b) => Number(dead[a]) - Number(dead[b]) || a - b);
  const variants = order.map((i) => vs[i]);
  // Keep the playing variant when it works (the user may have picked it); else the first working one.
  const idx = dead[active] ? 0 : order.indexOf(active);
  const v = variants[idx];
  return { ...c, variants, url: v.url, fallbackUrls: fallbacksFor(variants, idx), quality: v.quality, qualityLabel: qualityLabel(v.quality) };
}

// ---------------------------------------------------------------- the check itself

export type CheckResult =
  | { kind: 'ok' }
  | { kind: 'fail'; why: string }
  /** No verdict about the channel. `cors`: the browser blocked it; `slow`: provider asks us to back off. */
  | { kind: 'skip'; why: string; cors?: boolean; slow?: boolean }
  | { kind: 'aborted' };

export const CHECK_BYTES = 16 * 1024;
export const CHECK_TIMEOUT = 8000;

/** Statuses that say the channel is gone (or the server is broken). */
const DEAD_STATUS = (s: number) => s === 403 || s === 404 || s === 410 || (s >= 500 && s !== 509);
/** "Too many requests / connections": back off, don't blame the channel. */
const SLOW_STATUS = (s: number) => s === 429 || s === 458 || s === 509;

/** Is this body the start of a stream? HTML / JSON / short text pages are not. */
export function looksLikeStream(bytes: Uint8Array, contentType: string): boolean {
  if (!bytes.length) return false;
  if (engineFromBytes(bytes, contentType)) return true;
  const ct = contentType.toLowerCase();
  if (/text\/html|application\/json|text\/plain|xml/.test(ct)) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  if (/^(<!doctype|<html|<\?xml|\{|\[|<head|<body)/.test(head)) return false;
  // Some other binary container (FLV header, AAC/MP3 audio...): give it the benefit of the doubt.
  return true;
}

/** Can this channel's link be checked here? (Web: only plain links a browser can fetch.) */
export function checkableHere(url: string, c: OrgChannel): boolean {
  if (!isHttpUrl(url)) return false;
  if (isDesktop()) return true;
  if (/^https?:\/\/[^/]*@/i.test(url)) return false; // logins in the link: a browser refuses those
  if (Object.keys(channelHeaders(c)).length) return false; // needs a User-Agent/Referer a browser can't send
  if (typeof location !== 'undefined' && location.protocol === 'https:' && /^http:/i.test(url)) return false; // mixed content
  return true;
}

/**
 * Request the start of a stream and decide whether it's alive: read up to 16 KB or 8 s, then
 * close the connection. Desktop sends the playlist headers via the shell (like the player).
 */
export async function checkStream(url: string, c: OrgChannel, signal: AbortSignal): Promise<CheckResult> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, CHECK_TIMEOUT);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let gotResponse = false;
  try {
    let fetchUrl = url;
    if (isDesktop()) {
      const { url: clean, authorization } = splitUserinfo(url);
      fetchUrl = clean;
      const headers = channelHeaders(c);
      await desktop()!.setStreamHeaders?.(clean, authorization ? { ...headers, Authorization: authorization } : headers);
      if (signal.aborted) return { kind: 'aborted' };
    }
    const res = await fetch(fetchUrl, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    gotResponse = true;
    if (SLOW_STATUS(res.status)) return { kind: 'skip', why: `HTTP ${res.status}`, slow: true };
    if (DEAD_STATUS(res.status)) return { kind: 'fail', why: `HTTP ${res.status}` };
    if (res.status >= 400) return { kind: 'skip', why: `HTTP ${res.status}` }; // 401 etc.: the account, not the channel
    reader = res.body?.getReader();
    let buf = new Uint8Array(0);
    while (reader && buf.length < CHECK_BYTES) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
    return looksLikeStream(buf, res.headers.get('content-type') ?? '') ? { kind: 'ok' } : { kind: 'fail', why: buf.length ? 'not a stream' : 'empty response' };
  } catch {
    if (signal.aborted) return { kind: 'aborted' };
    if (timedOut) return { kind: 'fail', why: 'timeout' };
    // Web: a failed fetch is indistinguishable from a CORS block, so it never counts.
    if (!isDesktop()) return { kind: 'skip', why: 'blocked by the browser', cors: !gotResponse };
    return { kind: 'fail', why: 'no connection' };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    await reader?.cancel().catch(() => {});
    signal.removeEventListener('abort', onAbort);
  }
}

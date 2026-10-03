import type { Channel } from '../types';
import { cleanHeaderValue, safeImageUrl, safeStreamUrl, safeUrl } from './url';

export interface M3UParseResult {
  channels: Channel[];
  /** Entries skipped because of missing/invalid URLs or malformed lines. */
  skipped: { line: number; reason: string }[];
  /** url-tvg / x-tvg-url from the #EXTM3U header, if present. */
  epgUrl?: string;
}

/** Parse key="value" (or key=value) attribute pairs from an #EXTINF/#EXTM3U line. */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  return out;
}

/** Find the comma that separates attributes from the display name, ignoring commas inside quotes. */
function splitTitle(info: string): [string, string] {
  let quote: string | null = null;
  for (let i = 0; i < info.length; i++) {
    const ch = info[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') return [info.slice(0, i), info.slice(i + 1).trim()];
  }
  return [info, ''];
}

/** decodeURIComponent that never throws (bad % escapes are kept as written). */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse Kodi-style "Name=value&Name2=value2" header options (values URL-encoded, may contain '='). */
export function parseHeaderPairs(s: string): [string, string][] {
  const out: [string, string][] = [];
  for (const kv of s.split('&')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    out.push([safeDecode(kv.slice(0, eq)).trim(), safeDecode(kv.slice(eq + 1))]);
  }
  return out;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** Request options collected for the next playlist entry. */
class HttpOpts {
  userAgent?: string;
  referrer?: string;
  headers: Record<string, string> = {};
  set(name: string, value: string) {
    const v = cleanHeaderValue(value);
    const n = name.trim();
    if (!v || !HEADER_NAME.test(n)) return;
    const lower = n.toLowerCase();
    if (lower === 'user-agent') this.userAgent = v;
    else if (lower === 'referer' || lower === 'referrer') this.referrer = v;
    else {
      for (const k of Object.keys(this.headers)) if (k.toLowerCase() === lower) delete this.headers[k];
      this.headers[n] = v;
    }
  }
}

// #EXTVLCOPT / EXTINF attribute names → HTTP header names.
const VLC_OPTS: Record<string, string> = {
  'http-user-agent': 'User-Agent',
  'user-agent': 'User-Agent',
  'http-referrer': 'Referer',
  'http-referer': 'Referer',
  referrer: 'Referer',
  referer: 'Referer',
  'http-origin': 'Origin',
  'http-cookie': 'Cookie',
};

function markFor(name: string) {
  const bare = name.replace(/^\s*(\[[^\]]+\]|[A-Z]{2,3}\s*[:|])\s*/i, '');
  const words = bare.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? '??').slice(0, 2).toUpperCase();
}

export function parseM3U(text: string, sourceId = 'import', numberStart = 500): M3UParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const channels: Channel[] = [];
  const skipped: M3UParseResult['skipped'] = [];
  let epgUrl: string | undefined;

  let pending: { attrs: Record<string, string>; name: string; line: number } | null = null;
  let group: string | undefined;
  let opts = new HttpOpts();
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      const a = parseAttributes(line);
      epgUrl = safeUrl(a['url-tvg'] ?? a['x-tvg-url']) ?? undefined;
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      if (pending) skipped.push({ line: pending.line, reason: 'EXTINF without URL' });
      const colon = line.indexOf(':');
      const [attrPart, name] = splitTitle(colon >= 0 ? line.slice(colon + 1) : '');
      pending = { attrs: parseAttributes(attrPart), name, line: i + 1 };
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      group = line.slice(8).trim() || undefined;
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      const body = line.slice(11);
      const eq = body.indexOf('=');
      const header = eq > 0 ? VLC_OPTS[body.slice(0, eq).trim().toLowerCase()] : undefined;
      if (header) opts.set(header, body.slice(eq + 1));
      continue;
    }
    if (line.startsWith('#EXTHTTP:')) {
      // #EXTHTTP:{"User-Agent":"...","cookie":"..."}
      try {
        const json: unknown = JSON.parse(line.slice(9));
        if (json && typeof json === 'object') for (const [k, v] of Object.entries(json)) if (typeof v === 'string') opts.set(k, v);
      } catch {
        /* malformed: ignore */
      }
      continue;
    }
    if (line.startsWith('#KODIPROP:')) {
      // #KODIPROP:inputstream.adaptive.stream_headers=User-Agent=x&Referer=y
      const body = line.slice(10);
      const eq = body.indexOf('=');
      if (eq > 0 && /^inputstream\.adaptive\.(stream|manifest|common)_headers$/i.test(body.slice(0, eq).trim())) {
        for (const [k, v] of parseHeaderPairs(body.slice(eq + 1))) opts.set(k, v);
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    // URL line
    if (!pending) {
      skipped.push({ line: i + 1, reason: 'URL without EXTINF' });
      continue;
    }
    // Some providers append |User-Agent=...&Referer=...&Origin=... to the URL (Kodi style).
    const pipe = line.indexOf('|');
    const rawUrl = pipe >= 0 ? line.slice(0, pipe) : line;
    if (pipe >= 0) for (const [k, v] of parseHeaderPairs(line.slice(pipe + 1))) opts.set(k, v);
    const url = safeStreamUrl(rawUrl);
    if (!url) {
      skipped.push({ line: i + 1, reason: 'Invalid or unsupported URL' });
      pending = null;
      opts = new HttpOpts();
      continue;
    }

    const a = pending.attrs;
    // EXTINF attributes are the weakest source: only fill what directives/pipe options didn't set.
    const fromAttrs = new HttpOpts();
    for (const [k, h] of Object.entries(VLC_OPTS)) if (a[k]) fromAttrs.set(h, a[k]);
    const headers = { ...fromAttrs.headers, ...opts.headers };
    const name = (pending.name || a['tvg-name'] || `Channel ${channels.length + 1}`).slice(0, 120);
    const chno = parseInt(a['tvg-chno'] ?? a['channel-number'] ?? '', 10);
    let id = `${sourceId}:${a['tvg-id'] || name}`.toLowerCase();
    if (seen.has(id)) id = `${id}#${channels.length}`;
    seen.add(id);

    channels.push({
      id,
      number: Number.isFinite(chno) ? chno : numberStart + channels.length,
      name,
      group: (a['group-title'] || group || 'Imported').slice(0, 60),
      mark: markFor(name),
      logo: safeImageUrl(a['tvg-logo']),
      url,
      tvgId: a['tvg-id'] || undefined,
      sourceId,
      userAgent: opts.userAgent || fromAttrs.userAgent || undefined,
      referrer: opts.referrer || fromAttrs.referrer || undefined,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    pending = null;
    opts = new HttpOpts();
  }
  if (pending) skipped.push({ line: pending.line, reason: 'EXTINF without URL' });

  return { channels, skipped, epgUrl };
}

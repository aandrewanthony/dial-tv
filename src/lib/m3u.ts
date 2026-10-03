import type { Channel } from '../types';
import { safeImageUrl, safeUrl } from './url';

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
  let opts: { userAgent?: string; referrer?: string } = {};
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
      const [k, ...v] = line.slice(11).split('=');
      const val = v.join('=').trim();
      if (/http-user-agent/i.test(k)) opts.userAgent = val;
      if (/http-referr?er/i.test(k)) opts.referrer = val;
      continue;
    }
    if (line.startsWith('#')) continue;

    // URL line
    if (!pending) {
      skipped.push({ line: i + 1, reason: 'URL without EXTINF' });
      continue;
    }
    // Some providers append |User-Agent=...&Referer=... to the URL (Kodi style).
    const [rawUrl, pipeOpts] = line.split('|');
    if (pipeOpts) {
      for (const kv of pipeOpts.split('&')) {
        const [k, v] = kv.split('=');
        if (/user-agent/i.test(k)) opts.userAgent = decodeURIComponent(v ?? '');
        if (/referr?er/i.test(k)) opts.referrer = decodeURIComponent(v ?? '');
      }
    }
    const url = safeUrl(rawUrl);
    if (!url) {
      skipped.push({ line: i + 1, reason: 'Invalid or unsupported URL' });
      pending = null;
      opts = {};
      continue;
    }

    const a = pending.attrs;
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
      userAgent: opts.userAgent || a['user-agent'] || undefined,
      referrer: opts.referrer || undefined,
    });
    pending = null;
    opts = {};
  }
  if (pending) skipped.push({ line: pending.line, reason: 'EXTINF without URL' });

  return { channels, skipped, epgUrl };
}

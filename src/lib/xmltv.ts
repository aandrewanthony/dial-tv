import type { Program } from '../types';

export interface XmltvChannel {
  id: string;
  names: string[];
  icon?: string;
}

export interface XmltvParseResult {
  channels: XmltvChannel[];
  /** Programs keyed by XMLTV channel id (not yet mapped to playlist channels). */
  programs: (Omit<Program, 'channelId'> & { xmltvChannel: string })[];
  errors: number;
}

/**
 * Parse XMLTV date "YYYYMMDDHHmmss +HHMM" (offset and seconds optional) into epoch ms.
 * Without an offset XMLTV implies UTC.
 */
export function parseXmltvDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{2}:?\d{2}|Z)?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00', tz] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const offMin = parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2, 4), 10);
    ms -= sign * offMin * 60000;
  }
  return Number.isFinite(ms) ? ms : null;
}

const SPORTS_RE = /\b(sports?|football|basketball|baseball|hockey|soccer|nfl|nba|mlb|nhl|ncaa|golf|tennis|boxing|mma|ufc)\b/i;

export function parseXMLTV(xml: string): XmltvParseResult {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Invalid XMLTV: document is not well-formed XML');
  }
  const text = (el: Element | null | undefined) => el?.textContent?.trim() || undefined;

  const channels: XmltvChannel[] = [];
  for (const c of Array.from(doc.getElementsByTagName('channel'))) {
    const id = c.getAttribute('id');
    if (!id) continue;
    channels.push({
      id,
      names: Array.from(c.getElementsByTagName('display-name')).map((n) => n.textContent?.trim() || '').filter(Boolean),
      icon: c.getElementsByTagName('icon')[0]?.getAttribute('src') || undefined,
    });
  }

  const programs: XmltvParseResult['programs'] = [];
  const openEnded = new Set<string>();
  let errors = 0;
  let n = 0;
  for (const p of Array.from(doc.getElementsByTagName('programme'))) {
    const ch = p.getAttribute('channel');
    const start = parseXmltvDate(p.getAttribute('start'));
    const stop = parseXmltvDate(p.getAttribute('stop'));
    const title = text(p.getElementsByTagName('title')[0]);
    if (!ch || start == null || !title) {
      errors++;
      continue;
    }
    const categories = Array.from(p.getElementsByTagName('category')).map((c) => c.textContent?.trim() || '');
    const category = categories[0] || 'General';
    const id = `x${n++}:${ch}:${start}`;
    if (stop == null) openEnded.add(id);
    programs.push({
      id,
      xmltvChannel: ch,
      title,
      subtitle: text(p.getElementsByTagName('sub-title')[0]),
      description: text(p.getElementsByTagName('desc')[0]),
      start,
      // Missing stop: runs until the next programme (fixed up below), else 30 minutes.
      end: stop ?? start + 30 * 60000,
      category,
      isSports: categories.some((c) => SPORTS_RE.test(c)) || SPORTS_RE.test(title),
      isNew: p.getElementsByTagName('new').length > 0,
    });
  }

  // Open-ended programmes run until the next one; overlapping ones are clamped to it.
  const byCh = new Map<string, typeof programs>();
  for (const p of programs) {
    const arr = byCh.get(p.xmltvChannel) ?? [];
    arr.push(p);
    byCh.set(p.xmltvChannel, arr);
  }
  for (const arr of byCh.values()) {
    arr.sort((a, b) => a.start - b.start);
    for (let i = 0; i < arr.length - 1; i++) {
      const next = arr[i + 1].start;
      if (arr[i].end > next || (openEnded.has(arr[i].id) && next - arr[i].start <= 12 * 3600_000)) arr[i].end = next;
    }
  }

  return { channels, programs: programs.filter((p) => p.end > p.start), errors };
}

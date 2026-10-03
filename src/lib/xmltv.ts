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

export interface XmltvWindow {
  /** Drop programmes that end at or before this instant (epoch ms). */
  from?: number;
  /** Drop programmes that start at or after this instant (epoch ms). */
  to?: number;
}

/** Open-ended programmes can stretch up to this long (until the next programme). */
const OPEN_END_MAX = 12 * 3600_000;

export function parseXMLTV(xml: string, window: XmltvWindow = {}): XmltvParseResult {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Invalid XMLTV: document is not well-formed XML');
  }
  const from = window.from ?? -Infinity;
  const to = window.to ?? Infinity;
  const first = (el: Element, tag: string) => el.getElementsByTagName(tag)[0];
  const text = (el: Element | null | undefined) => el?.textContent?.trim() || undefined;

  const channels: XmltvChannel[] = [];
  const chEls = doc.getElementsByTagName('channel');
  for (let i = 0; i < chEls.length; i++) {
    const c = chEls[i];
    const id = c.getAttribute('id');
    if (!id) continue;
    const names: string[] = [];
    const dn = c.getElementsByTagName('display-name');
    for (let j = 0; j < dn.length; j++) {
      const n = dn[j].textContent?.trim();
      if (n) names.push(n);
    }
    channels.push({ id, names, icon: first(c, 'icon')?.getAttribute('src') || undefined });
  }

  const programs: XmltvParseResult['programs'] = [];
  const openEnded = new Set<string>();
  let errors = 0;
  let n = 0;
  const progEls = doc.getElementsByTagName('programme');
  for (let i = 0; i < progEls.length; i++) {
    const p = progEls[i];
    const ch = p.getAttribute('channel');
    const start = parseXmltvDate(p.getAttribute('start'));
    if (!ch || start == null) {
      errors++;
      continue;
    }
    const stop = parseXmltvDate(p.getAttribute('stop'));
    // Window check on the cheap attributes before touching child elements.
    if (start >= to) continue;
    if (stop != null ? stop <= from : start + OPEN_END_MAX <= from) continue;
    const title = text(first(p, 'title'));
    if (!title) {
      errors++;
      continue;
    }
    const catEls = p.getElementsByTagName('category');
    const categories: string[] = [];
    for (let j = 0; j < catEls.length; j++) categories.push(catEls[j].textContent?.trim() || '');
    const category = categories[0] || 'General';
    const id = `x${n++}:${ch}:${start}`;
    if (stop == null) openEnded.add(id);
    programs.push({
      id,
      xmltvChannel: ch,
      title,
      subtitle: text(first(p, 'sub-title')),
      description: text(first(p, 'desc')),
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
    const arr = byCh.get(p.xmltvChannel);
    if (arr) arr.push(p);
    else byCh.set(p.xmltvChannel, [p]);
  }
  for (const arr of byCh.values()) {
    arr.sort((a, b) => a.start - b.start);
    for (let i = 0; i < arr.length - 1; i++) {
      const next = arr[i + 1].start;
      if (arr[i].end > next || (openEnded.has(arr[i].id) && next - arr[i].start <= OPEN_END_MAX)) arr[i].end = next;
    }
  }

  return { channels, programs: programs.filter((p) => p.end > p.start && p.end > from && p.start < to), errors };
}

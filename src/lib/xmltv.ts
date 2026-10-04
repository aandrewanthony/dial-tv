import type { Program } from '../types';

/**
 * XMLTV parsing.
 *
 * `XmltvStreamParser` is a small, tolerant tag scanner that works on a text stream (it runs in the
 * guide Web Worker, where DOMParser doesn't exist). Feed it chunks with `push()` and call `end()`.
 * It understands just what XMLTV needs: <channel> (id, display-name, icon) and <programme>
 * (channel/start/stop, title, sub-title, desc, category, new). Entities and CDATA are decoded,
 * attributes may come in any order with either quote, comments/PIs/DOCTYPE are skipped, and tags
 * split across chunk boundaries are handled. Programmes the caller doesn't want (outside the time
 * window, or for channels nobody watches) are skipped without parsing their bodies.
 *
 * `parseXMLTV` is the old whole-document API, now built on the stream parser.
 */

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

/** A programme as scanned (before windowing / open-end fix-up). `stop` is null when missing. */
export interface RawProgramme {
  channel: string;
  start: number;
  stop: number | null;
  title?: string;
  subtitle?: string;
  desc?: string;
  categories: string[];
  isNew: boolean;
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

export const SPORTS_RE = /\b(sports?|football|basketball|baseball|hockey|soccer|nfl|nba|mlb|nhl|ncaa|golf|tennis|boxing|mma|ufc)\b/i;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode XML character/entity references (&amp; &#38; &#x26; …). Unknown entities are kept as-is. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e] ?? m;
  });
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return out;
}

export interface StreamHandlers {
  channel?(c: XmltvChannel): void;
  /** Called with a programme's attributes before its body is parsed: return false to skip it cheaply. */
  accept?(channel: string, start: number, stop: number | null): boolean;
  programme?(p: RawProgramme): void;
}

const enum Mode { None, Channel, Programme, Skip }
/** A tag longer than this without a closing '>' is treated as stray text (keeps memory bounded). */
const MAX_TAG = 64 * 1024;

const TEXT_FIELDS = new Set(['title', 'sub-title', 'desc', 'category', 'display-name']);

export class XmltvStreamParser {
  /** Malformed constructs seen (unclosed elements, programmes without channel/start/title, …). */
  errors = 0;
  /** A <tv> root element was seen. */
  sawRoot = false;
  channelCount = 0;
  programmeCount = 0;
  skipped = 0;

  private buf = '';
  private pos = 0;
  private mode = Mode.None;
  private ch: XmltvChannel | null = null;
  private pr: RawProgramme | null = null;
  private field: string | null = null;
  private text: string[] = [];

  constructor(private h: StreamHandlers = {}) {}

  push(chunk: string) {
    this.buf = this.pos ? this.buf.slice(this.pos) + chunk : this.buf + chunk;
    this.pos = 0;
    this.scan(false);
  }

  end() {
    this.scan(true);
    if (this.mode === Mode.Channel || this.mode === Mode.Programme) this.errors++;
    this.mode = Mode.None;
    this.ch = this.pr = null;
    this.field = null;
    this.buf = '';
    this.pos = 0;
  }

  private scan(final: boolean) {
    const b = this.buf;
    const n = b.length;
    let i = this.pos;
    for (;;) {
      if (this.mode === Mode.Skip) {
        const j = b.indexOf('</programme', i);
        if (j < 0) {
          i = Math.max(i, n - 11);
          if (final) i = n;
          break;
        }
        const k = b.indexOf('>', j);
        if (k < 0) {
          i = final ? n : j;
          break;
        }
        i = k + 1;
        this.mode = Mode.None;
        continue;
      }
      const lt = b.indexOf('<', i);
      if (lt < 0) {
        // Text outside a field is just whitespace: drop it. Field text waits for its closing tag.
        if (!this.field || final) i = n;
        break;
      }
      if (this.field && lt > i) this.text.push(decodeEntities(b.slice(i, lt)));
      if (lt + 1 >= n) {
        i = final ? n : lt;
        break;
      }
      const c1 = b.charCodeAt(lt + 1);
      if (c1 === 33 /* ! */) {
        if (n - lt < 9 && !final) {
          i = lt;
          break;
        }
        if (b.startsWith('<!--', lt)) {
          const j = b.indexOf('-->', lt + 4);
          if (j < 0) {
            i = final ? n : lt;
            break;
          }
          i = j + 3;
          continue;
        }
        if (b.startsWith('<![CDATA[', lt)) {
          const j = b.indexOf(']]>', lt + 9);
          if (j < 0) {
            i = final ? n : lt;
            break;
          }
          if (this.field) this.text.push(b.slice(lt + 9, j));
          i = j + 3;
          continue;
        }
        // <!DOCTYPE …> (possibly with an internal subset [ … ]>)
        const gt = b.indexOf('>', lt);
        const br = b.indexOf('[', lt);
        const j = br >= 0 && (gt < 0 || br < gt) ? b.indexOf(']>', br) : gt;
        if (j < 0) {
          i = final ? n : lt;
          break;
        }
        i = j + (b.charCodeAt(j) === 93 ? 2 : 1);
        continue;
      }
      if (c1 === 63 /* ? */) {
        const j = b.indexOf('?>', lt + 2);
        if (j < 0) {
          i = final ? n : lt;
          break;
        }
        i = j + 2;
        continue;
      }
      // Element tag: find its '>' outside quoted attribute values.
      let end = -1;
      let q = 0;
      const lim = Math.min(n, lt + MAX_TAG);
      for (let k = lt + 1; k < lim; k++) {
        const c = b.charCodeAt(k);
        if (q) {
          if (c === q) q = 0;
        } else if (c === 62) {
          end = k;
          break;
        } else if (c === 34 || c === 39) q = c;
      }
      if (end < 0) {
        if (lim < n || final) {
          // Runaway tag (stray '<' or unbalanced quote): treat the '<' as text and move on.
          this.errors++;
          i = lt + 1;
          continue;
        }
        i = lt;
        break;
      }
      const closing = c1 === 47;
      const selfClose = !closing && b.charCodeAt(end - 1) === 47;
      const ns = lt + (closing ? 2 : 1);
      let ne = ns;
      while (ne < end) {
        const c = b.charCodeAt(ne);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 62) break;
        ne++;
      }
      const name = b.slice(ns, ne);
      i = end + 1;
      if (closing) this.close(name);
      else this.open(name, b, ne, selfClose ? end - 1 : end, selfClose);
      // The skip fast path runs at the top of the loop.
    }
    this.pos = i;
  }

  private open(name: string, b: string, attrFrom: number, attrTo: number, selfClose: boolean) {
    if (name === 'programme') {
      if (this.mode !== Mode.None) this.abandon();
      const a = parseAttrs(b.slice(attrFrom, attrTo));
      const channel = a.channel;
      const start = parseXmltvDate(a.start);
      if (!channel || start == null) {
        this.errors++;
        if (!selfClose) this.mode = Mode.Skip;
        return;
      }
      const stop = parseXmltvDate(a.stop);
      if (this.h.accept && !this.h.accept(channel, start, stop)) {
        this.skipped++;
        if (!selfClose) this.mode = Mode.Skip;
        return;
      }
      this.pr = { channel, start, stop, categories: [], isNew: false };
      this.mode = Mode.Programme;
      if (selfClose) this.emitProgramme();
      return;
    }
    if (name === 'channel') {
      if (this.mode !== Mode.None) this.abandon();
      const a = parseAttrs(b.slice(attrFrom, attrTo));
      this.ch = { id: a.id ?? '', names: [] };
      this.mode = Mode.Channel;
      if (selfClose) this.emitChannel();
      return;
    }
    if (this.mode === Mode.Channel || this.mode === Mode.Programme) {
      if (TEXT_FIELDS.has(name)) {
        if (!this.field && !selfClose) {
          this.field = name;
          this.text = [];
        }
        return;
      }
      if (this.mode === Mode.Programme && (name === 'new' || name === 'premiere')) {
        if (name === 'new') this.pr!.isNew = true;
        return;
      }
      if (this.mode === Mode.Channel && name === 'icon' && this.ch && !this.ch.icon) {
        const src = parseAttrs(b.slice(attrFrom, attrTo)).src;
        if (src) this.ch.icon = src;
      }
      return;
    }
    if (name === 'tv') this.sawRoot = true;
  }

  private close(name: string) {
    if (this.field) {
      if (name === this.field) {
        this.finishField();
        return;
      }
      // A parent closed while the field was open: keep what we have.
      if (name === 'programme' || name === 'channel' || name === 'tv') this.finishField();
      else return;
    }
    if (name === 'programme' && this.mode === Mode.Programme) this.emitProgramme();
    else if (name === 'channel' && this.mode === Mode.Channel) this.emitChannel();
    else if (name === 'tv' && this.mode !== Mode.None) this.abandon();
  }

  private finishField() {
    const v = this.text.join('').trim();
    const f = this.field;
    this.field = null;
    this.text = [];
    if (this.mode === Mode.Channel && this.ch) {
      if (f === 'display-name' && v) this.ch.names.push(v);
      return;
    }
    const p = this.pr;
    if (this.mode !== Mode.Programme || !p) return;
    if (f === 'title') p.title ??= v || undefined;
    else if (f === 'sub-title') p.subtitle ??= v || undefined;
    else if (f === 'desc') p.desc ??= v || undefined;
    else if (f === 'category' && v) p.categories.push(v);
  }

  /** An element was left open (malformed): drop it. */
  private abandon() {
    this.errors++;
    this.mode = Mode.None;
    this.ch = this.pr = null;
    this.field = null;
    this.text = [];
  }

  private emitChannel() {
    const c = this.ch;
    this.mode = Mode.None;
    this.ch = null;
    if (!c || !c.id) {
      this.errors++;
      return;
    }
    this.channelCount++;
    this.h.channel?.(c);
  }

  private emitProgramme() {
    const p = this.pr;
    this.mode = Mode.None;
    this.pr = null;
    if (!p || !p.title) {
      this.errors++;
      return;
    }
    this.programmeCount++;
    this.h.programme?.(p);
  }
}

export interface XmltvWindow {
  /** Drop programmes that end at or before this instant (epoch ms). */
  from?: number;
  /** Drop programmes that start at or after this instant (epoch ms). */
  to?: number;
}

/** Open-ended programmes can stretch up to this long (until the next programme). */
export const OPEN_END_MAX = 12 * 3600_000;
/** Open-ended programme with no next programme in reach: assume this long. */
export const OPEN_END_DEFAULT = 30 * 60_000;

/** Quick window check on a programme's attributes (an open-ended one may run up to OPEN_END_MAX). */
export function inWindow(start: number, stop: number | null, from: number, to: number) {
  if (start >= to) return false;
  return stop != null ? stop > from : start + OPEN_END_MAX > from;
}

/**
 * Fix up the ends of one channel's programmes, sorted by start: an open-ended programme runs until
 * the next one (within OPEN_END_MAX, else OPEN_END_DEFAULT), and overlapping ones are clamped.
 * `starts`/`ends` are parallel arrays; `ends[i]` is NaN for a missing stop.
 */
export function fixEnds(starts: ArrayLike<number>, ends: number[]) {
  const n = ends.length;
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? starts[i + 1] : Infinity;
    if (Number.isNaN(ends[i])) ends[i] = next - starts[i] <= OPEN_END_MAX ? next : starts[i] + OPEN_END_DEFAULT;
    else if (ends[i] > next) ends[i] = next;
  }
}

export function parseXMLTV(xml: string, window: XmltvWindow = {}): XmltvParseResult {
  const from = window.from ?? -Infinity;
  const to = window.to ?? Infinity;
  const channels: XmltvChannel[] = [];
  const raw: RawProgramme[] = [];
  const parser = new XmltvStreamParser({
    channel: (c) => channels.push(c),
    accept: (_c, start, stop) => inWindow(start, stop, from, to),
    programme: (p) => raw.push(p),
  });
  parser.push(xml);
  parser.end();
  if (!channels.length && !raw.length && (parser.errors > 0 || !parser.sawRoot) && !parser.skipped) {
    throw new Error('Invalid XMLTV: document is not well-formed XML');
  }

  const byCh = new Map<string, RawProgramme[]>();
  for (const p of raw) {
    const arr = byCh.get(p.channel);
    if (arr) arr.push(p);
    else byCh.set(p.channel, [p]);
  }
  const programs: XmltvParseResult['programs'] = [];
  let n = 0;
  for (const [ch, arr] of byCh) {
    arr.sort((a, b) => a.start - b.start);
    const starts = arr.map((p) => p.start);
    const ends = arr.map((p) => (p.stop == null ? NaN : p.stop));
    fixEnds(starts, ends);
    arr.forEach((p, i) => {
      const end = ends[i];
      if (!(end > p.start && end > from && p.start < to)) return;
      const category = p.categories[0] || 'General';
      programs.push({
        id: `x${n++}:${ch}:${p.start}`,
        xmltvChannel: ch,
        title: p.title!,
        subtitle: p.subtitle,
        description: p.desc,
        start: p.start,
        end,
        category,
        isSports: p.categories.some((c) => SPORTS_RE.test(c)) || SPORTS_RE.test(p.title!),
        isNew: p.isNew,
      });
    });
  }
  return { channels, programs, errors: parser.errors };
}

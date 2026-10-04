/**
 * One guide load: download (streamed) → gunzip → parse → match → window → compact cache.
 * Runs inside the guide worker; the main thread can run it too as a fallback (it yields often).
 */
import { inWindow, XmltvStreamParser, type XmltvChannel } from '../lib/xmltv';
import { EpgMatcher, GuideCollector, guideWindow, type GuideCache, type GuideSourceMeta, type MatchChannel } from './epgCore';
import { readAppFile, writeGuideCache } from './guideDb';

export interface GuideJobSource {
  id: string;
  name?: string;
  /** xmltv-url */
  url?: string;
  /** xmltv-file stored by the app under kv `file:<id>` */
  fileId?: string;
  /** Direct content (tests / imports handed over in memory). */
  text?: string;
  blob?: Blob;
}

export interface GuideJobRequest {
  sources: GuideJobSource[];
  channels: MatchChannel[];
  manual: Record<string, string>;
  days: number;
  now: number;
  /** Write the result to the guide cache (IndexedDB). */
  save: boolean;
  /** Running in the desktop app (affects the CORS error message only). */
  desktop?: boolean;
}

export interface GuideJobProgress {
  phase: 'download' | 'parse' | 'save';
  source?: string;
  sourceIndex: number;
  sourceCount: number;
  /** Bytes received (compressed, as sent by the server). */
  bytes: number;
  total?: number;
  /** Programmes scanned / kept so far. */
  programmes: number;
  kept: number;
}

const CORS_MSG = 'Request blocked. The server may not allow browser access (CORS) — use the Dial TV desktop app, which works with any provider.';

async function openSource(src: GuideJobSource, signal: AbortSignal | undefined, desktop: boolean): Promise<{ stream?: ReadableStream<Uint8Array>; text?: string; total?: number }> {
  if (src.text != null) return { text: src.text };
  if (src.blob) return { stream: src.blob.stream() as ReadableStream<Uint8Array>, total: src.blob.size };
  if (src.fileId) {
    const v = await readAppFile(src.fileId);
    if (v == null) throw new Error('Imported guide file is missing — import it again');
    if (typeof v === 'string') return { text: v };
    return { stream: v.stream() as ReadableStream<Uint8Array>, total: v.size };
  }
  if (!src.url) throw new Error('No URL');
  let res: Response;
  try {
    res = await fetch(src.url, { signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(desktop ? `Download failed: ${(e as Error).message}` : CORS_MSG);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length'));
  const enc = res.headers.get('content-encoding');
  // With Content-Encoding the length is of the compressed body, which we can't count here.
  const total = Number.isFinite(len) && len > 0 && !enc ? len : undefined;
  if (!res.body) return { text: await res.text(), total };
  return { stream: res.body, total };
}

/** Charset from the XML declaration (UTF-8 unless it says otherwise). */
function sniffCharset(head: Uint8Array): string {
  const s = String.fromCharCode(...head.subarray(0, 200));
  const m = /encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(s);
  const enc = m?.[1].toLowerCase();
  if (!enc || enc === 'utf-8' || enc === 'utf8') return 'utf-8';
  try {
    new TextDecoder(enc);
    return enc;
  } catch {
    return 'utf-8';
  }
}

export async function runGuideJob(
  req: GuideJobRequest,
  onProgress: (p: GuideJobProgress) => void,
  signal?: AbortSignal,
  /** Called between chunks; return a promise to yield (main-thread fallback). */
  maybeYield?: () => Promise<void> | void,
): Promise<GuideCache> {
  const win = guideWindow(req.now, req.days);
  const col = new GuideCollector(win.from, win.to);
  const metas: GuideSourceMeta[] = req.sources.map((s) => ({ id: s.id, name: s.name, programmes: 0, channels: 0 }));
  const tvgLower = new Set(req.channels.map((c) => c.tvgId?.toLowerCase()).filter(Boolean) as string[]);
  const manualKeys = new Set(Object.values(req.manual));
  const epgSeen: XmltvChannel[] = [];
  let scanned = 0;
  let okSources = 0;
  let lastErr: Error | undefined;

  for (let si = 0; si < req.sources.length; si++) {
    const src = req.sources[si];
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let bytes = 0;
    let total: number | undefined;
    let lastReport = 0;
    let wanted: Map<string, boolean> | null = null;
    let wantedKeys = new Set<string>();
    const isWanted = (id: string) => {
      if (!wanted) {
        // All <channel> elements come before the programmes: match once, at the first programme.
        const m = new EpgMatcher(epgSeen);
        wantedKeys = new Set([...m.resolveAll(req.channels, req.manual).values()].map((r) => r.key));
        for (const k of wantedKeys) col.markWanted(k);
        wanted = new Map();
      }
      let w = wanted.get(id);
      if (w == null) {
        w = wantedKeys.has(id) || manualKeys.has(id) || tvgLower.has(id.toLowerCase());
        wanted.set(id, w);
        if (w) col.markWanted(id);
      }
      return w;
    };
    const parser = new XmltvStreamParser({
      channel: (c) => {
        epgSeen.push(c);
        col.addChannel(c);
      },
      accept: (ch, start, stop) => inWindow(start, stop, win.from, win.to) && isWanted(ch) && col.wants(ch, si),
      programme: (p) => col.add(p, si),
    });
    const report = (phase: GuideJobProgress['phase'], force = false) => {
      const t = Date.now();
      if (!force && t - lastReport < 120) return;
      lastReport = t;
      onProgress({ phase, source: src.name ?? src.id, sourceIndex: si, sourceCount: req.sources.length, bytes, total, programmes: scanned + parser.programmeCount + parser.skipped, kept: col.size });
    };
    try {
      report('download', true);
      const opened = await openSource(src, signal, !!req.desktop);
      total = opened.total;
      if (opened.text != null) {
        const text = opened.text;
        const STEP = 1 << 20;
        for (let o = 0; o < text.length; o += STEP) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          parser.push(text.slice(o, o + STEP));
          bytes = Math.min(text.length, o + STEP);
          report('parse');
          await maybeYield?.();
        }
      } else if (opened.stream) {
        const reader = opened.stream.getReader();
        const first = await reader.read();
        const head = first.value ?? new Uint8Array();
        const gz = head[0] === 0x1f && head[1] === 0x8b;
        // Re-emit the first chunk, then pass the rest through, counting received bytes.
        const counted = new ReadableStream<Uint8Array>({
          start(ctrl) {
            if (head.length) {
              bytes += head.length;
              ctrl.enqueue(head);
            }
            if (first.done) ctrl.close();
          },
          async pull(ctrl) {
            const r = await reader.read();
            if (r.done) return ctrl.close();
            bytes += r.value.length;
            ctrl.enqueue(r.value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        let body: ReadableStream<Uint8Array> = counted;
        if (gz) {
          if (typeof DecompressionStream === 'undefined') throw new Error('Cannot decompress this guide: gzip not supported here');
          body = counted.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
        }
        const r2 = body.getReader();
        let decoder: TextDecoder | null = null;
        for (;;) {
          if (signal?.aborted) {
            void r2.cancel();
            throw new DOMException('Aborted', 'AbortError');
          }
          const { done, value } = await r2.read();
          if (done) break;
          decoder ??= new TextDecoder(sniffCharset(value));
          parser.push(decoder.decode(value, { stream: true }));
          report(bytes < (total ?? Infinity) ? 'download' : 'parse');
          await maybeYield?.();
        }
        if (decoder) parser.push(decoder.decode());
      }
      parser.end();
      scanned += parser.programmeCount + parser.skipped;
      if (!parser.sawRoot && !parser.channelCount && !parser.programmeCount) throw new Error('This does not look like an XMLTV guide');
      metas[si].bytes = bytes;
      okSources++;
      report('parse', true);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      lastErr = e as Error;
      metas[si].error = (e as Error).message;
      scanned += parser.programmeCount + parser.skipped;
    }
  }
  if (!okSources && lastErr) throw lastErr;
  col.scanned = scanned;
  onProgress({ phase: 'save', sourceIndex: req.sources.length - 1, sourceCount: req.sources.length, bytes: 0, programmes: scanned, kept: col.size });
  const cache = col.finish({ savedAt: Date.now(), days: win.days, sources: metas });
  if (req.save) await writeGuideCache(cache);
  return cache;
}

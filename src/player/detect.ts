/**
 * Decide which playback engine a stream URL needs. Many IPTV links have no file
 * extension (e.g. http://host/live/user/pass/123), so for those we peek at the
 * first bytes: "#EXTM3U" → HLS, 0x47 sync byte → MPEG-TS, "ftyp" → MP4.
 */
export type Engine = 'hls' | 'mpegts' | 'native';

export function engineFromExtension(url: string): Engine | null {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (/\.m3u8?$/.test(path)) return 'hls';
  if (/\.(ts|flv|mts|m2ts)$/.test(path)) return 'mpegts';
  if (/\.(mp4|webm|mov|m4v|mkv|mp3|m4a|aac|ogg|oga|opus|wav)$/.test(path)) return 'native';
  return null;
}

/** Classify from response headers + the first bytes of the body. */
export function engineFromBytes(bytes: Uint8Array, contentType = ''): Engine | null {
  const ct = contentType.toLowerCase();
  // MPEG-TS: 188-byte packets, each starting with 0x47.
  if (bytes.length >= 189 && bytes[0] === 0x47 && bytes[188] === 0x47) return 'mpegts';
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('#EXTM3U')) return 'hls';
  if (bytes.length >= 8 && head.slice(4, 8) === 'ftyp') return 'native';
  if (/mpegurl/.test(ct)) return 'hls';
  if (/mp2t|x-flv/.test(ct)) return 'mpegts';
  if (bytes[0] === 0x47) return 'mpegts';
  if (/^video\/(mp4|webm)/.test(ct)) return 'native';
  return null;
}

export interface Sniff {
  engine: Engine;
  /** HTTP status when the server refused the stream (>= 400). */
  status?: number;
}

/**
 * Extension first (no request at all); otherwise read the first ~1 KB of the response.
 * The sniff connection is fully closed before this resolves, so the real player never
 * shares the provider's connection limit with it. Falls back to HLS.
 */
export async function sniffStream(url: string, signal?: AbortSignal): Promise<Sniff> {
  const byExt = engineFromExtension(url);
  if (byExt) return { engine: byExt };
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, 6000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status >= 400) return { engine: 'hls', status: res.status };
    reader = res.body?.getReader();
    let buf = new Uint8Array(0);
    while (reader && buf.length < 1024) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
    return { engine: engineFromBytes(buf, res.headers.get('content-type') ?? '') ?? 'hls' };
  } catch {
    return { engine: 'hls' }; // blocked (e.g. CORS in a browser) or timed out: let hls.js report the real error
  } finally {
    clearTimeout(timer);
    // Stop downloading an endless live feed and close the socket before the real player connects.
    ctrl.abort();
    await reader?.cancel().catch(() => {});
    signal?.removeEventListener('abort', abort);
  }
}

export async function detectEngine(url: string, signal?: AbortSignal): Promise<Engine> {
  return (await sniffStream(url, signal)).engine;
}

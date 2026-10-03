/**
 * Network helpers. In the browser, playlist/EPG hosts must send CORS headers.
 * The desktop app (Electron) adds CORS headers to the app's own fetch/XHR/media
 * responses, so plain fetch() and hls.js work against any IPTV provider there.
 */
import type { Channel } from '../types';
import { cleanHeaderValue } from './url';

export type HeaderMap = Record<string, string>;

export interface DesktopBridge {
  platform: string;
  setMiniPlayer(on: boolean): Promise<boolean>;
  version(): Promise<string>;
  /** Register request headers the shell adds to this stream's requests (and same-host segments). */
  setStreamHeaders?(url: string, headers: HeaderMap): Promise<boolean>;
  decoder?: {
    info(): Promise<{ available: boolean }>;
    probe(url: string, headers?: HeaderMap): Promise<StreamInfo | null>;
    url(src: string, headers?: HeaderMap): Promise<string | null>;
    /** Codecs found by the decoder server's own probe (no extra connection). */
    infoFor?(src: string): Promise<StreamInfo | null>;
  };
}

/** Codecs of a stream as reported by the desktop decoder's ffmpeg probe. */
export interface StreamInfo {
  video: string | null;
  audio: string | null;
  interlaced: boolean;
  resolution: string | null;
  /** e.g. yuv420p10le; 10-bit / 4:2:2 H.264 needs converting. */
  pixFmt?: string | null;
  /** e.g. "High 10", "Main". */
  profile?: string | null;
  /** Upstream HTTP error seen while probing (e.g. 404). */
  httpStatus?: number | null;
}

/** A channel's playlist request headers (User-Agent, Referer, Origin, Cookie, ...), sanitized. */
export function channelHeaders(c: Pick<Channel, 'userAgent' | 'referrer' | 'headers'>): HeaderMap {
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(c.headers ?? {})) {
    const val = cleanHeaderValue(v);
    if (val && /^[A-Za-z0-9-]+$/.test(k)) out[k] = val;
  }
  const ua = cleanHeaderValue(c.userAgent);
  const ref = cleanHeaderValue(c.referrer);
  if (ua) out['User-Agent'] = ua;
  if (ref) out.Referer = ref;
  return out;
}

export const desktop = (): DesktopBridge | undefined =>
  typeof window !== 'undefined' ? (window as unknown as { dialDesktop?: DesktopBridge }).dialDesktop : undefined;

export const isDesktop = () => !!desktop();

async function maybeGunzip(res: Response, url: string): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  const gz = buf[0] === 0x1f && buf[1] === 0x8b;
  if (!gz) return new TextDecoder().decode(buf);
  if (typeof DecompressionStream === 'undefined') throw new Error(`Cannot decompress ${url}: gzip not supported here`);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (!isDesktop()) {
      throw new Error('Request blocked. The server may not allow browser access (CORS) — use the Dial TV desktop app, which works with any provider.');
    }
    throw e;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return maybeGunzip(res, url);
}

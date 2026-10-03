/**
 * Network helpers. In the browser, playlist/EPG hosts must send CORS headers.
 * In the Tauri desktop app we route through the native HTTP plugin instead,
 * which is not subject to CORS — most IPTV providers don't send CORS headers.
 */

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

type FetchFn = typeof fetch;
let nativeFetch: Promise<FetchFn> | null = null;

export function getFetch(): Promise<FetchFn> {
  if (!isTauri()) return Promise.resolve(window.fetch.bind(window));
  nativeFetch ??= import('@tauri-apps/plugin-http').then((m) => m.fetch as FetchFn).catch(() => window.fetch.bind(window));
  return nativeFetch;
}

async function maybeGunzip(res: Response, url: string): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  const gz = buf[0] === 0x1f && buf[1] === 0x8b;
  if (!gz) return new TextDecoder().decode(buf);
  if (typeof DecompressionStream === 'undefined') throw new Error(`Cannot decompress ${url}: gzip not supported here`);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const f = await getFetch();
  let res: Response;
  try {
    res = await f(url, { signal });
  } catch (e) {
    if (!isTauri()) {
      throw new Error('Request blocked. The server may not allow browser access (CORS) — use the desktop app, or a host that sends CORS headers.');
    }
    throw e;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return maybeGunzip(res, url);
}

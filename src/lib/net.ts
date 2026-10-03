/**
 * Network helpers. In the browser, playlist/EPG hosts must send CORS headers.
 * The desktop app (Electron) adds CORS headers to every response in its own
 * session, so plain fetch() and hls.js work against any IPTV provider there.
 */

export interface DesktopBridge {
  platform: string;
  setMiniPlayer(on: boolean): Promise<boolean>;
  version(): Promise<string>;
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

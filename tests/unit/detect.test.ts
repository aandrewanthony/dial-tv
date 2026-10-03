import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineFromBytes, engineFromExtension, sniffStream } from '../../src/player/detect';

const ts = () => { const b = new Uint8Array(376); b[0] = 0x47; b[188] = 0x47; return b; };
const text = (s: string) => new TextEncoder().encode(s);

describe('stream engine detection', () => {
  it('uses the extension when there is one', () => {
    expect(engineFromExtension('http://h/live/u/p/1.m3u8?token=x')).toBe('hls');
    expect(engineFromExtension('http://h/live/u/p/1.ts')).toBe('mpegts');
    expect(engineFromExtension('http://h/movie/u/p/1.mp4')).toBe('native');
    expect(engineFromExtension('http://h/live/u/p/1')).toBeNull();
    expect(engineFromExtension('https://h/k8s/live.isml/.m3u8')).toBe('hls');
    expect(engineFromExtension('http://radio.example/stream.mp3')).toBe('native');
    expect(engineFromExtension('http://h/a.mkv?x=1')).toBe('native');
  });
  it('sniffs extension-less links from their first bytes', () => {
    expect(engineFromBytes(ts(), 'application/octet-stream')).toBe('mpegts');
    expect(engineFromBytes(text('#EXTM3U\n#EXT-X-VERSION:3\n'), 'text/plain')).toBe('hls');
    expect(engineFromBytes(text('﻿  #EXTM3U\n'))).toBe('hls');
    expect(engineFromBytes(text('\0\0\0\x20ftypisom'))).toBe('native');
  });
  it('falls back to content-type, else unknown', () => {
    expect(engineFromBytes(new Uint8Array(0), 'application/vnd.apple.mpegurl')).toBe('hls');
    expect(engineFromBytes(new Uint8Array(0), 'video/mp2t')).toBe('mpegts');
    expect(engineFromBytes(text('<html>'), 'text/html')).toBeNull();
  });
});

describe('sniffStream', () => {
  afterEach(() => vi.unstubAllGlobals());
  const response = (status: number, chunks: Uint8Array[], type = '') => {
    const cancel = vi.fn(async () => {});
    let i = 0;
    const reader = { read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }), cancel };
    return { res: { status, headers: new Headers({ 'content-type': type }), body: { getReader: () => reader } }, cancel };
  };

  it('makes no request when the extension is known', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await sniffStream('http://h/live/1.ts')).toEqual({ engine: 'mpegts' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('closes the sniff connection before resolving', async () => {
    const { res, cancel } = response(200, [ts()]);
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { signal = init.signal ?? undefined; return res; }));
    expect(await sniffStream('http://h/live/u/p/1')).toEqual({ engine: 'mpegts' });
    expect(cancel).toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
  });
  it('reports HTTP errors so the player can fall back right away', async () => {
    const { res } = response(403, []);
    vi.stubGlobal('fetch', vi.fn(async () => res));
    expect(await sniffStream('http://h/live/u/p/1')).toEqual({ engine: 'hls', status: 403 });
  });
  it('falls back to HLS when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('blocked'); }));
    expect(await sniffStream('http://h/live/u/p/1')).toEqual({ engine: 'hls' });
  });
});

import { describe, expect, it } from 'vitest';
import { engineFromBytes, engineFromExtension } from '../../src/player/detect';

const ts = () => { const b = new Uint8Array(376); b[0] = 0x47; b[188] = 0x47; return b; };
const text = (s: string) => new TextEncoder().encode(s);

describe('stream engine detection', () => {
  it('uses the extension when there is one', () => {
    expect(engineFromExtension('http://h/live/u/p/1.m3u8?token=x')).toBe('hls');
    expect(engineFromExtension('http://h/live/u/p/1.ts')).toBe('mpegts');
    expect(engineFromExtension('http://h/movie/u/p/1.mp4')).toBe('native');
    expect(engineFromExtension('http://h/live/u/p/1')).toBeNull();
    expect(engineFromExtension('https://h/k8s/live.isml/.m3u8')).toBe('hls');
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

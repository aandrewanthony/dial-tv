import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const d = require('../../electron/decoder.cjs');

const HIGH10 = `Input #0, mpegts, from 'http://h/x':
  Stream #0:0[0x100]: Video: h264 (High 10) ([27][0][0][0] / 0x001B), yuv420p10le(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 50 fps
  Stream #0:1[0x101](eng): Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp, 130 kb/s`;
const MPEG2 = `  Stream #0:0[0x31]: Video: mpeg2video (Main) ([2][0][0][0] / 0x0002), yuv420p(tv, top first), 1920x1080 [SAR 1:1 DAR 16:9], 29.97 fps
  Stream #0:1[0x34](eng): Audio: ac3 ([129][0][0][0] / 0x0081), 48000 Hz, 5.1(side), fltp, 384 kb/s`;
const PLAIN = '  Stream #0:0[0x100]: Video: h264 ([27][0][0][0] / 0x001B), yuv420p(progressive), 1280x720\n  Stream #0:1: Audio: aac, 48000 Hz';

describe('decoder probe parsing', () => {
  it('reads codecs, profile, pixel format and interlacing', () => {
    expect(d.parseProbe(HIGH10)).toEqual({ video: 'h264', audio: 'aac', interlaced: false, resolution: '1920x1080', pixFmt: 'yuv420p10le', profile: 'High 10' });
    expect(d.parseProbe(MPEG2)).toMatchObject({ video: 'mpeg2video', audio: 'ac3', interlaced: true, profile: 'Main', pixFmt: 'yuv420p' });
    expect(d.parseProbe(PLAIN)).toMatchObject({ video: 'h264', profile: null, pixFmt: 'yuv420p' });
    expect(d.parseProbe('Connection refused')).toBeNull();
  });
  it('re-encodes 10-bit / 4:2:2 H.264 instead of copying it', () => {
    expect(d.needsVideoTranscode(d.parseProbe(HIGH10))).toBe(true);
    expect(d.needsVideoTranscode({ video: 'h264', profile: 'High 4:2:2', pixFmt: null })).toBe(true);
    expect(d.needsVideoTranscode(d.parseProbe(PLAIN))).toBe(false);
    expect(d.needsVideoTranscode(null)).toBe(true);
    const args: string[] = d.transcodeArgs('http://h/x', {}, d.parseProbe(HIGH10));
    expect(args).toContain('libx264');
    expect(args).not.toContain('copy');
    expect(d.transcodeArgs('http://h/x', {}, d.parseProbe(PLAIN))).toContain('copy');
  });
  it('spots upstream HTTP errors in ffmpeg output', () => {
    expect(d.parseHttpStatus('[http @ 0x1] HTTP error 404 Not Found')).toBe(404);
    expect(d.parseHttpStatus('http://h/x: Server returned 403 Forbidden (access denied)')).toBe(403);
    expect(d.parseHttpStatus('Server returned 4XX Client Error, but not one of 40{0,1,3,4}')).toBe(400);
    expect(d.parseHttpStatus('Server returned 5XX Server Error reply')).toBe(502);
    expect(d.parseHttpStatus('Invalid data found when processing input')).toBeNull();
  });
});

describe('decoder input safety', () => {
  it('accepts VLC protocols, rejects local/script ones', () => {
    expect(d.normalizeSource('udp://@239.1.1.1:1234')).toBe('udp://@239.1.1.1:1234');
    expect(d.normalizeSource('mms://h/live')).toBe('mmsh://h/live');
    expect(d.normalizeSource(' rtsp://cam/1 ')).toBe('rtsp://cam/1');
    for (const bad of ['file:///C:/x', 'concat:a|b', 'data:,x', 'javascript:x', 'subfile,,0,1,:file.ts', 'ftp://h/x', '', 'http://a b']) {
      expect(d.normalizeSource(bad)).toBeNull();
    }
  });
  it('whitelists exactly the network protocols ffmpeg needs (no file:/concat:)', () => {
    const args: string[] = d.inputArgs('https://h/x.m3u8', {});
    const wl = args[args.indexOf('-protocol_whitelist') + 1].split(',');
    expect(wl).toEqual(expect.arrayContaining(['http', 'https', 'tcp', 'tls', 'crypto', 'hls', 'udp', 'rtp', 'rtmp', 'rtsp', 'srt', 'mmsh']));
    expect(wl).not.toContain('file');
    expect(wl).not.toContain('concat');
    expect(wl).not.toContain('data');
  });
  it('only sends HTTP options to http(s), with VLC UA default and no CR/LF injection', () => {
    const http: string[] = d.inputArgs('http://h/x', { 'User-Agent': 'Evil\r\nX-Injected: 1', Referer: 'https://r/\r\n', Origin: 'https://o', 'Bad Name': 'x', Host: 'evil' });
    expect(http[http.indexOf('-user_agent') + 1]).toBe('Evil X-Injected: 1');
    expect(http[http.indexOf('-headers') + 1]).toBe('Referer: https://r/\r\nOrigin: https://o\r\n');
    expect(d.inputArgs('http://h/x', {})).toContain(d.VLC_UA);
    const rtmp: string[] = d.inputArgs('rtmp://h/app/key', { 'User-Agent': 'x' });
    expect(rtmp).not.toContain('-user_agent');
    expect(rtmp).not.toContain('-reconnect');
    expect(rtmp).toContain('-rw_timeout');
    const rtsp: string[] = d.inputArgs('rtsp://cam/1', {});
    expect(rtsp[rtsp.indexOf('-rtsp_transport') + 1]).toBe('tcp');
    const udp: string[] = d.inputArgs('udp://@239.1.1.1:1234', {});
    expect(udp[udp.length - 1]).toBe('udp://@239.1.1.1:1234');
    expect(udp).toContain('-timeout');
  });
  it('redacts credentials before logging', () => {
    expect(d.redactUrl('http://bob:pw@h.example/live/bob/pw/1.ts?token=abc&x=1')).toBe('http://***@h.example/live/***/***/1.ts?token=***&x=1');
    expect(d.redactUrl('http://h.example:8080/bob/pw/12345')).toBe('http://h.example:8080/***/***/12345');
    expect(d.redactUrl('rtmp://h/app?username=u&password=p')).toBe('rtmp://h/app?username=***&password=***');
    expect(d.redactText("[http @ 0x1] Opening 'http://u:p@h/live/u/p/1.ts' for reading")).toBe("[http @ 0x1] Opening 'http://***@h/live/***/***/1.ts' for reading");
  });
});

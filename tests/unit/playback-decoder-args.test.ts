import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const d = require('../../electron/decoder.cjs');

type Info = { video: string | null; audio?: string | null; interlaced?: boolean; resolution?: string | null; pixFmt?: string | null; profile?: string | null; duration?: number | null };
const H264_720: Info = { video: 'h264', audio: 'aac', interlaced: false, resolution: '1280x720', pixFmt: 'yuv420p', profile: 'High', duration: null };
const MPEG2_1080I: Info = { video: 'mpeg2video', audio: 'ac3', interlaced: true, resolution: '1920x1080', pixFmt: 'yuv420p', profile: 'Main', duration: null };
const HEVC_MOVIE: Info = { video: 'hevc', audio: 'eac3', interlaced: false, resolution: '3840x2160', pixFmt: 'yuv420p10le', profile: 'Main 10', duration: 7200 };

const args = (info: Info | null, opts?: object, encoder?: string): string[] => d.transcodeArgs('http://h/x', {}, info, opts, encoder);
const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

describe('decoder options sanitizing', () => {
  it('defaults for missing / non-object input', () => {
    for (const raw of [undefined, null, 'x', 5, [1, 2]]) expect(d.sanitizeOptions(raw)).toEqual(d.DEFAULT_OPTS);
  });
  it('keeps valid values', () => {
    const o = { preset: 'superfast', maxHeight: 720, deinterlace: 'on', hw: true, lowLatency: true, ss: 61.34, lead: 20 };
    expect(d.sanitizeOptions(o)).toEqual({ ...o, ss: 61.3 });
  });
  it('rejects unknown presets, heights and flags; clamps numbers', () => {
    expect(d.sanitizeOptions({ preset: 'placebo; rm -rf', maxHeight: 999, deinterlace: 'maybe', hw: 'yes', lowLatency: 1, ss: -5, lead: 1e9 }))
      .toEqual({ preset: 'veryfast', maxHeight: 0, deinterlace: 'auto', hw: false, lowLatency: false, ss: 0, lead: 120 });
    expect(d.sanitizeOptions({ ss: Number.NaN, lead: Infinity })).toMatchObject({ ss: 0, lead: 0 });
    expect(d.sanitizeOptions({ ss: 1e12 }).ss).toBe(7 * 24 * 3600);
  });
});

describe('decoder bitrate + encoder args', () => {
  it('picks target / peak by output height', () => {
    expect(d.rateFor(480)).toEqual([2000, 3000]);
    expect(d.rateFor(720)).toEqual([4000, 6000]);
    expect(d.rateFor(1080)).toEqual([6500, 10000]);
    expect(d.rateFor(0)).toEqual([6500, 10000]);
    expect(d.rateFor(2160)).toEqual([16000, 25000]);
  });
  it('libx264: preset, VBV from the height, zerolatency only for low latency', () => {
    const a: string[] = d.videoEncoderArgs(null, { ...d.DEFAULT_OPTS, preset: 'superfast' }, 720);
    expect(a.slice(0, 4)).toEqual(['-c:v', 'libx264', '-preset', 'superfast']);
    expect(after(a, '-maxrate')).toBe('6000k');
    expect(after(a, '-bufsize')).toBe('12000k');
    expect(after(a, '-pix_fmt')).toBe('yuv420p');
    expect(a).not.toContain('zerolatency');
    expect(d.videoEncoderArgs(undefined, { ...d.DEFAULT_OPTS, lowLatency: true }, 1080)).toContain('zerolatency');
  });
  it('hardware encoders get their own flags and a bitrate target', () => {
    for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox']) {
      const a: string[] = d.videoEncoderArgs(enc, d.DEFAULT_OPTS, 1080);
      expect(after(a, '-c:v')).toBe(enc);
      expect(after(a, '-b:v')).toBe('6500k');
      expect(a).not.toContain('libx264');
    }
    expect(after(d.videoEncoderArgs('h264_nvenc', { ...d.DEFAULT_OPTS, lowLatency: true }, 720), '-tune')).toBe('ll');
    expect(after(d.videoEncoderArgs('h264_nvenc', d.DEFAULT_OPTS, 720), '-tune')).toBe('hq');
    expect(after(d.videoEncoderArgs('h264_qsv', d.DEFAULT_OPTS, 720), '-pix_fmt')).toBe('nv12');
  });
  it('lists hardware candidates per platform', () => {
    expect(d.HW_CANDIDATES.win32).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf']);
    expect(d.HW_CANDIDATES.darwin).toEqual(['h264_videotoolbox']);
  });
});

describe('decoder transcode args', () => {
  it('copies browser-safe H.264 and always converts audio to stereo AAC MPEG-TS on stdout', () => {
    const a = args(H264_720);
    expect(after(a, '-c:v')).toBe('copy');
    expect(a).not.toContain('-vf');
    expect(after(a, '-c:a')).toBe('aac');
    expect(after(a, '-ac')).toBe('2');
    expect(a.slice(-5)).toEqual(['-f', 'mpegts', '-mpegts_flags', '+resend_headers', 'pipe:1']);
    expect(a.indexOf('-map')).toBeGreaterThan(a.indexOf('-i'));
  });
  it('live with a known probe skips long analysis before -i; unknown probe does not', () => {
    const a = args(H264_720);
    expect(a.indexOf('-probesize')).toBeGreaterThan(-1);
    expect(a.indexOf('-probesize')).toBeLessThan(a.indexOf('-i'));
    expect(args(null)).not.toContain('-probesize');
  });
  it('unknown probe re-encodes at 1080p rates with libx264', () => {
    const a = args(null);
    expect(after(a, '-c:v')).toBe('libx264');
    expect(after(a, '-maxrate')).toBe('10000k');
  });
  it('deinterlaces interlaced MPEG-2 on auto (marked frames only), every frame when forced', () => {
    expect(after(args(MPEG2_1080I), '-vf')).toBe('yadif=0:-1:1');
    expect(after(args(MPEG2_1080I, { deinterlace: 'on' }), '-vf')).toBe('yadif=0:-1:0');
    expect(args(MPEG2_1080I, { deinterlace: 'off' })).not.toContain('-vf');
  });
  it('forced deinterlace re-encodes interlaced H.264 instead of copying', () => {
    const a = args({ ...H264_720, interlaced: true }, { deinterlace: 'on' });
    expect(after(a, '-c:v')).toBe('libx264');
    expect(after(a, '-vf')).toBe('yadif=0:-1:0');
    expect(after(args({ ...H264_720, interlaced: false }, { deinterlace: 'on' }), '-c:v')).toBe('copy');
  });
  it('scales down to max height and sizes the bitrate from it', () => {
    const a = args(MPEG2_1080I, { maxHeight: 720 });
    expect(after(a, '-vf')).toBe('yadif=0:-1:1,scale=-2:min(ih\\,720)');
    expect(after(a, '-maxrate')).toBe('6000k');
    expect(after(args(HEVC_MOVIE), '-maxrate')).toBe('25000k'); // source height (2160) when uncapped
  });
  it('uses the given hardware encoder and preset', () => {
    expect(after(args(MPEG2_1080I, {}, 'h264_qsv'), '-c:v')).toBe('h264_qsv');
    expect(after(args(MPEG2_1080I, { preset: 'faster' }), '-preset')).toBe('faster');
  });
  it('movies: input seek, real-time pacing without a lead, progress output with one', () => {
    const paced = args(HEVC_MOVIE, { ss: 90 });
    expect(after(paced, '-ss')).toBe('90');
    expect(paced.indexOf('-ss')).toBeLessThan(paced.indexOf('-i'));
    expect(paced.indexOf('-re')).toBeLessThan(paced.indexOf('-i'));
    expect(paced).not.toContain('-probesize');
    const lead = args(HEVC_MOVIE, { lead: 20 });
    expect(lead).not.toContain('-re');
    expect(after(lead, '-progress')).toBe('pipe:2');
    expect(lead.indexOf('-progress')).toBeLessThan(lead.indexOf('-i'));
    expect(lead).not.toContain('-ss');
  });
  it('live ignores ss; low latency flushes packets', () => {
    expect(args(H264_720, { ss: 90 })).not.toContain('-ss');
    const a = args(H264_720, { lowLatency: true });
    expect(after(a, '-flush_packets')).toBe('1');
    expect(args(H264_720)).not.toContain('-flush_packets');
  });
  it('without options behaves like the defaults', () => {
    expect(args(MPEG2_1080I)).toEqual(args(MPEG2_1080I, d.DEFAULT_OPTS));
  });
});

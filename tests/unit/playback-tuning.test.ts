import { describe, expect, it } from 'vitest';
import {
  BUFFER_PROFILES, bufferProfile, decoderOptions, gateOptions, hlsConfig, levelLimits, maxHeight, mpegtsConfig, resolveComputer, type Machine,
} from '../../src/player/tuning';
import { DEFAULT_PLAYBACK, type PlaybackSettings } from '../../src/store/app';

const pb = (o: Partial<PlaybackSettings> = {}): PlaybackSettings => ({ ...DEFAULT_PLAYBACK, ...o });
const machine = (o: Partial<Machine> = {}): Machine => ({ threads: 8, memoryGb: 8, hwEncoder: null, ...o });
const LIVE = { vod: false };

describe('tuning: computer level', () => {
  it('uses an explicit level as-is', () => {
    expect(resolveComputer('high', { threads: 2, memoryGb: 2 })).toBe('high');
    expect(resolveComputer('low', { threads: 32, memoryGb: 8 })).toBe('low');
  });
  it('resolves auto from threads and memory', () => {
    expect(resolveComputer('auto', { threads: 4, memoryGb: 8 })).toBe('low');
    expect(resolveComputer('auto', { threads: 16, memoryGb: 4 })).toBe('low');
    expect(resolveComputer('auto', { threads: 8, memoryGb: null })).toBe('medium');
    expect(resolveComputer('auto', { threads: 12, memoryGb: 8 })).toBe('high');
    expect(resolveComputer('auto', { threads: 12, memoryGb: null })).toBe('high');
  });
});

describe('tuning: buffer profile + gate', () => {
  it('falls back to auto for unknown profiles', () => {
    expect(bufferProfile(pb({ buffer: 'smooth' }))).toBe('smooth');
    expect(bufferProfile(pb({ buffer: 'bogus' as PlaybackSettings['buffer'] }))).toBe('auto');
  });
  it('live gates come straight from the profile table', () => {
    for (const name of Object.keys(BUFFER_PROFILES) as (keyof typeof BUFFER_PROFILES)[]) {
      const p = BUFFER_PROFILES[name];
      expect(gateOptions(pb({ buffer: name }), LIVE)).toEqual({ startGate: p.startGate, rebuffer: p.rebuffer, rebufferMax: p.rebufferMax, maxWait: p.maxWait });
    }
  });
  it('VOD starts at once; low latency uses a smaller rebuffer cushion', () => {
    expect(gateOptions(pb(), { vod: true })).toEqual({ startGate: 0, rebuffer: 4, rebufferMax: 10, maxWait: 15 });
    expect(gateOptions(pb({ buffer: 'low-latency' }), { vod: true })).toMatchObject({ startGate: 0, rebuffer: 2, rebufferMax: 4 });
  });
  it('profiles grow monotonically from low latency to max', () => {
    const order = ['low-latency', 'balanced', 'auto', 'smooth', 'max'] as const;
    for (let i = 1; i < order.length; i++) {
      expect(BUFFER_PROFILES[order[i]].startGate).toBeGreaterThanOrEqual(BUFFER_PROFILES[order[i - 1]].startGate);
      expect(BUFFER_PROFILES[order[i]].hlsForward).toBeGreaterThanOrEqual(BUFFER_PROFILES[order[i - 1]].hlsForward);
    }
  });
});

describe('tuning: hls.js config', () => {
  it('auto keeps hls.js live defaults', () => {
    const c = hlsConfig(pb(), LIVE);
    expect(c).toMatchObject({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30, capLevelToPlayerSize: false });
    for (const k of ['liveSyncDurationCount', 'maxBufferLength', 'startPosition', 'startLevel', 'maxLiveSyncPlaybackRate']) expect(c).not.toHaveProperty(k);
  });
  it('low latency chases the edge', () => {
    expect(hlsConfig(pb({ buffer: 'low-latency' }), LIVE)).toMatchObject({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, maxLiveSyncPlaybackRate: 1.15, maxBufferLength: 8 });
  });
  it('smooth / max buffer further ahead', () => {
    expect(hlsConfig(pb({ buffer: 'smooth' }), LIVE)).toMatchObject({ liveSyncDurationCount: 4, maxBufferLength: 45, maxBufferSize: 90e6 });
    expect(hlsConfig(pb({ buffer: 'max' }), LIVE)).toMatchObject({ liveSyncDurationCount: 5, maxBufferLength: 60, maxBufferSize: 120e6 });
    expect(hlsConfig(pb({ buffer: 'balanced' }), LIVE)).not.toHaveProperty('maxBufferLength');
  });
  it('compact tiles cap to the player size; lowest start quality starts at level 0', () => {
    expect(hlsConfig(pb(), { vod: false, compact: true }).capLevelToPlayerSize).toBe(true);
    expect(hlsConfig(pb({ startQuality: 'lowest' }), LIVE).startLevel).toBe(0);
    expect(hlsConfig(pb({ startQuality: 'highest' }), LIVE)).not.toHaveProperty('startLevel');
  });
  it('VOD resumes at startAt and buffers at least 30 s', () => {
    expect(hlsConfig(pb(), { vod: true, startAt: 125 })).toMatchObject({ startPosition: 125, maxBufferLength: 30 });
    expect(hlsConfig(pb({ buffer: 'low-latency' }), { vod: true }).maxBufferLength).toBe(30);
    expect(hlsConfig(pb({ buffer: 'max' }), { vod: true }).maxBufferLength).toBe(60);
    expect(hlsConfig(pb(), { vod: true, startAt: 0 })).not.toHaveProperty('startPosition');
    expect(hlsConfig(pb(), { vod: false, startAt: 99 })).not.toHaveProperty('startPosition');
  });
});

describe('tuning: quality levels', () => {
  const levels = [
    { height: 360, bitrate: 800e3 },
    { height: 720, bitrate: 3e6 },
    { height: 720, bitrate: 4e6 },
    { height: 1080, bitrate: 6e6 },
  ];
  it('maps max resolution', () => {
    expect(maxHeight(pb())).toBe(0);
    expect(maxHeight(pb({ maxResolution: '720' }))).toBe(720);
    expect(maxHeight(pb({ maxResolution: '2160' }))).toBe(2160);
  });
  it('no cap on auto; start left to hls.js', () => {
    expect(levelLimits(levels, pb())).toEqual({ cap: -1, start: undefined });
  });
  it('caps to the best level at or under the limit', () => {
    expect(levelLimits(levels, pb({ maxResolution: '720' })).cap).toBe(2);
    expect(levelLimits(levels, pb({ maxResolution: '480' })).cap).toBe(0);
  });
  it('falls back to the smallest level when every level is taller than the limit', () => {
    expect(levelLimits([{ height: 1080, bitrate: 5e6 }, { height: 720, bitrate: 3e6 }], pb({ maxResolution: '480' })).cap).toBe(1);
  });
  it('ignores the cap when levels carry no heights', () => {
    expect(levelLimits([{ bitrate: 1e6 }, { bitrate: 2e6 }], pb({ maxResolution: '720' })).cap).toBe(-1);
  });
  it('start quality: highest within the cap, or lowest bitrate', () => {
    expect(levelLimits(levels, pb({ startQuality: 'highest' })).start).toBe(3);
    expect(levelLimits(levels, pb({ startQuality: 'highest', maxResolution: '720' })).start).toBe(2);
    expect(levelLimits(levels, pb({ startQuality: 'lowest' })).start).toBe(0);
  });
});

describe('tuning: mpegts.js config', () => {
  it('auto live: no chasing, gentle catch-up when far behind, no lazy load', () => {
    const c = mpegtsConfig(pb(), { vod: false, decoder: false });
    expect(c).toMatchObject({ enableStashBuffer: true, liveBufferLatencyChasing: false, liveSync: true, liveSyncMaxLatency: 40, liveSyncTargetLatency: 3, lazyLoad: false, autoCleanupMaxBackwardDuration: 40 });
  });
  it('low latency: no stash buffer, chases the edge, no rate catch-up', () => {
    expect(mpegtsConfig(pb({ buffer: 'low-latency' }), { vod: false, decoder: false })).toMatchObject({ enableStashBuffer: false, liveBufferLatencyChasing: true, liveSync: false });
  });
  it('smooth / max never speed up', () => {
    for (const buffer of ['smooth', 'max'] as const) {
      expect(mpegtsConfig(pb({ buffer }), { vod: false, decoder: false })).toMatchObject({ liveSync: false, liveSyncMaxLatency: 1.2, liveBufferLatencyChasing: false });
    }
  });
  it('VOD: lazy load only for direct files, never for the decoder stream', () => {
    expect(mpegtsConfig(pb(), { vod: true, decoder: false })).toMatchObject({ lazyLoad: true, liveSync: false, liveBufferLatencyChasing: false, autoCleanupMaxBackwardDuration: 180 });
    expect(mpegtsConfig(pb(), { vod: true, decoder: true }).lazyLoad).toBe(false);
  });
});

describe('tuning: decoder options', () => {
  it('defaults on a mid-range machine', () => {
    expect(decoderOptions(pb(), machine(), LIVE)).toEqual({ preset: 'veryfast', maxHeight: 0, deinterlace: 'auto', hw: false, lowLatency: false, ss: 0, lead: 0 });
  });
  it('preset follows the computer level; low machines are capped at 720p', () => {
    expect(decoderOptions(pb({ computer: 'high' }), machine(), LIVE)).toMatchObject({ preset: 'faster', maxHeight: 0 });
    expect(decoderOptions(pb({ computer: 'low' }), machine(), LIVE)).toMatchObject({ preset: 'superfast', maxHeight: 720 });
    expect(decoderOptions(pb({ computer: 'low', maxResolution: '480' }), machine(), LIVE).maxHeight).toBe(480);
    expect(decoderOptions(pb(), machine({ threads: 2 }), LIVE)).toMatchObject({ preset: 'superfast', maxHeight: 720 });
  });
  it('compact tiles drop one preset notch and cap at 720p', () => {
    expect(decoderOptions(pb({ computer: 'high' }), machine(), { vod: false, compact: true })).toMatchObject({ preset: 'veryfast', maxHeight: 720 });
    expect(decoderOptions(pb({ computer: 'low' }), machine(), { vod: false, compact: true }).preset).toBe('superfast');
    expect(decoderOptions(pb({ maxResolution: '480' }), machine(), { vod: false, compact: true }).maxHeight).toBe(480);
  });
  it('hardware acceleration: auto uses a detected encoder, on/off force it', () => {
    expect(decoderOptions(pb(), machine({ hwEncoder: 'h264_nvenc' }), LIVE).hw).toBe(true);
    expect(decoderOptions(pb({ hwAccel: 'off' }), machine({ hwEncoder: 'h264_nvenc' }), LIVE).hw).toBe(false);
    expect(decoderOptions(pb({ hwAccel: 'on' }), machine(), LIVE).hw).toBe(true);
  });
  it('passes deinterlace and low latency through', () => {
    expect(decoderOptions(pb({ deinterlace: 'on', buffer: 'low-latency' }), machine(), LIVE)).toMatchObject({ deinterlace: 'on', lowLatency: true });
  });
  it('VOD: seek position rounded down to 0.1 s and a lead by buffer profile', () => {
    expect(decoderOptions(pb(), machine(), { vod: true, startAt: 61.37 })).toMatchObject({ ss: 61.3, lead: 20 });
    expect(decoderOptions(pb({ buffer: 'max' }), machine(), { vod: true }).lead).toBe(60);
    expect(decoderOptions(pb({ buffer: 'low-latency' }), machine(), { vod: true }).lead).toBe(5);
    expect(decoderOptions(pb(), machine(), { vod: false, startAt: 30 })).toMatchObject({ ss: 0, lead: 0 });
  });
});

/**
 * Playback tuning: turns Settings → Playback (+ what this computer can do) into concrete
 * settings for each engine: hls.js, mpegts.js, the <video> start/rebuffer gate, and the
 * desktop decoder (ffmpeg).
 *
 * Why the defaults look like this (measured with tests/streamlab/buffer.mjs, see the report):
 * IPTV links are jittery: the connection pauses for 1–4 s and then catches up in a burst. The old
 * settings chased the live edge (mpegts.js kept ~0.5–1.5 s of video and skipped ahead whenever
 * more arrived; hls.js ran in low-latency mode), so every pause became a visible stall. "Auto"
 * now prefers zero stalls over latency: it starts quickly, and whenever the network does stall,
 * it waits until a real cushion (5 s, growing to 12 s) has arrived before playing on, so the next
 * pause is absorbed. hls.js keeps 30 s ahead and never speeds up or skips to chase the edge.
 */
import type { PlaybackSettings } from '../store/app';
import type { DecoderOptions } from '../lib/net';

export type BufferProfile = 'low-latency' | 'auto' | 'balanced' | 'smooth' | 'max';
export type ComputerLevel = 'low' | 'medium' | 'high';

/** What the player knows about this machine. */
export interface Machine {
  /** Logical CPU threads (navigator.hardwareConcurrency). */
  threads: number;
  /** Approximate RAM in GB (navigator.deviceMemory; Chromium caps it at 8). */
  memoryGb: number | null;
  /** Hardware H.264 encoder the desktop decoder found (h264_nvenc, h264_qsv, ...), if any. */
  hwEncoder: string | null;
}

export function machineInfo(hwEncoder: string | null = null): Machine {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & { deviceMemory?: number };
  return { threads: nav.hardwareConcurrency || 4, memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null, hwEncoder };
}

/** "auto" computer level from CPU threads and memory. */
export function resolveComputer(setting: PlaybackSettings['computer'], m: Pick<Machine, 'threads' | 'memoryGb'>): ComputerLevel {
  if (setting !== 'auto') return setting;
  if (m.threads <= 4 || (m.memoryGb != null && m.memoryGb <= 4)) return 'low';
  if (m.threads <= 8) return 'medium';
  return 'high';
}

/** Buffer behavior for one profile. All times in seconds. */
export interface BufferTuning {
  /** Live: video to have before the first frame plays. */
  startGate: number;
  /** After a stall: wait for this much video before playing on... */
  rebuffer: number;
  /** ...growing by 1.5x per stall up to this (a flaky source earns a bigger cushion). */
  rebufferMax: number;
  /** Never hold playback longer than this waiting for the cushion. */
  maxWait: number;
  /** mpegts.js: jump to the live edge (low latency only: skips video). */
  chase: boolean;
  /** Live latency above which playback speeds up gently (0 = never). */
  syncAbove: number;
  /** hls.js: segments behind the live edge to start at, and seconds to keep buffered ahead. */
  hlsSyncCount: number;
  hlsForward: number;
}

export const BUFFER_PROFILES: Record<BufferProfile, BufferTuning> = {
  'low-latency': { startGate: 0, rebuffer: 0.5, rebufferMax: 1, maxWait: 4, chase: true, syncAbove: 3, hlsSyncCount: 2, hlsForward: 8 },
  balanced: { startGate: 3, rebuffer: 1, rebufferMax: 2, maxWait: 3, chase: false, syncAbove: 20, hlsSyncCount: 3, hlsForward: 20 },
  auto: { startGate: 6, rebuffer: 1.5, rebufferMax: 3, maxWait: 4, chase: false, syncAbove: 40, hlsSyncCount: 2, hlsForward: 30 },
  smooth: { startGate: 10, rebuffer: 2, rebufferMax: 4, maxWait: 6, chase: false, syncAbove: 0, hlsSyncCount: 4, hlsForward: 45 },
  max: { startGate: 15, rebuffer: 3, rebufferMax: 6, maxWait: 8, chase: false, syncAbove: 0, hlsSyncCount: 5, hlsForward: 60 },
};

/** Movies / episodes: no live edge, so start at once and rebuffer to a modest cushion. */
// Live profiles (measured with tests/streamlab/buffer.mjs on /net/jitter): a cushion BEFORE playback
// starts absorbs hiccups; long holds after a stall only make each freeze longer (total frozen time
// doubled with 2.5→8 s holds), so holds stay short.
const VOD_GATE = { startGate: 0, rebuffer: 4, rebufferMax: 10, maxWait: 15 };

export const bufferProfile = (pb: PlaybackSettings): BufferProfile => (pb.buffer in BUFFER_PROFILES ? pb.buffer : 'auto') as BufferProfile;

export interface Ctx {
  vod: boolean;
  /** Small tile (Multiview, mini player): cheaper decoding, cap quality to the tile. */
  compact?: boolean;
  /** VOD start position (seconds). */
  startAt?: number;
}

export interface GateOptions { startGate: number; rebuffer: number; rebufferMax: number; maxWait: number }
export function gateOptions(pb: PlaybackSettings, ctx: Ctx): GateOptions {
  const p = BUFFER_PROFILES[bufferProfile(pb)];
  if (ctx.vod) return bufferProfile(pb) === 'low-latency' ? { ...VOD_GATE, rebuffer: 2, rebufferMax: 4 } : VOD_GATE;
  return { startGate: p.startGate, rebuffer: p.rebuffer, rebufferMax: p.rebufferMax, maxWait: p.maxWait };
}

/**
 * Live HLS gate. hls.js appends whole segments, so on a connection that only just keeps up the
 * browser resumes with one segment and freezes again at the next segment boundary (lab /net/slow:
 * 11 short freezes per 2 min plus a 12 s jump when playback fell out of the playlist window).
 * Holding for a bit more than one segment before starting, and again after a stall, rides out the
 * slow segments instead (2 freezes, no jump). null = no gate (low latency: play at once, let
 * hls.js handle stalls).
 */
const HLS_GATE: Record<BufferProfile, GateOptions | null> = {
  'low-latency': null,
  balanced: { startGate: 4, rebuffer: 4, rebufferMax: 6, maxWait: 6 },
  auto: { startGate: 5, rebuffer: 5, rebufferMax: 8, maxWait: 8 },
  smooth: { startGate: 8, rebuffer: 8, rebufferMax: 12, maxWait: 10 },
  max: { startGate: 12, rebuffer: 12, rebufferMax: 16, maxWait: 12 },
};
export const hlsGateOptions = (pb: PlaybackSettings, ctx: Ctx): GateOptions | null => (ctx.vod ? null : HLS_GATE[bufferProfile(pb)]);

/** hls.js config (merged over hls.js defaults). */
export function hlsConfig(pb: PlaybackSettings, ctx: Ctx) {
  const prof = bufferProfile(pb);
  const p = BUFFER_PROFILES[prof];
  // Measured in the lab (buffer.mjs, /net/slow + /net/jitter, single-rendition and 720p/360p ABR):
  // hls.js' defaults are kept for forward buffer (30 s), ABR (its 500 kbps first estimate starts
  // low; stricter abrBandWidthFactor / UpFactor changed nothing) and load/retry policies (a slow
  // first byte is not helped by retrying the same segment sooner). Auto only starts 2 segments
  // behind the edge instead of 3: the live gate (hlsGateOptions) adds its cushion on top, and
  // starting closer keeps that cushion inside the playlist window (no 12 s jumps, ~3.5 s less
  // latency, less frozen time than 3 + gate).
  const cfg: Record<string, unknown> = {
    enableWorker: true,
    lowLatencyMode: true, // only acts on LL-HLS playlists (parts)
    backBufferLength: 30,
    capLevelToPlayerSize: !!ctx.compact,
  };
  if (ctx.vod && ctx.startAt && ctx.startAt > 0) cfg.startPosition = ctx.startAt;
  if (pb.startQuality === 'lowest') cfg.startLevel = 0;
  if (prof === 'low-latency') Object.assign(cfg, { liveSyncDurationCount: p.hlsSyncCount, liveMaxLatencyDurationCount: 5, maxLiveSyncPlaybackRate: 1.15, maxBufferLength: p.hlsForward });
  if (prof === 'auto' && !ctx.vod) cfg.liveSyncDurationCount = p.hlsSyncCount;
  if (prof === 'smooth' || prof === 'max') Object.assign(cfg, { liveSyncDurationCount: p.hlsSyncCount, maxBufferLength: p.hlsForward, maxBufferSize: (prof === 'max' ? 120 : 90) * 1000 * 1000 });
  if (ctx.vod) cfg.maxBufferLength = Math.max(30, p.hlsForward);
  return cfg;
}

/**
 * hls.js config for the local pause & rewind buffer (electron/timeshift.cjs): a 30-minute sliding
 * playlist on disk. Never skip forward or speed up to chase the edge (the viewer chose to be behind),
 * start 2 segments behind the newest one, and keep some played video for quick small rewinds.
 */
export function timeshiftHlsConfig() {
  return {
    enableWorker: true,
    lowLatencyMode: false,
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: Infinity,
    maxLiveSyncPlaybackRate: 1,
    liveSyncOnStallIncrease: 0, // "LIVE" stays 2 segments back, so "behind live" stays meaningful
    liveDurationInfinity: false,
    maxBufferLength: 30,
    backBufferLength: 60,
  };
}

const RES: Record<string, number> = { '2160': 2160, '1080': 1080, '720': 720, '480': 480 };
export const maxHeight = (pb: PlaybackSettings) => RES[pb.maxResolution] ?? 0;

/**
 * Quality limits for an adaptive stream: the highest level allowed by Max resolution (-1 = no cap)
 * and the level to start at (undefined = hls.js decides from its bandwidth estimate).
 */
export function levelLimits(levels: { height?: number; bitrate?: number }[], pb: PlaybackSettings): { cap: number; start?: number } {
  const h = maxHeight(pb);
  let cap = -1;
  if (h && levels.some((l) => l.height)) {
    // Highest-bitrate level not taller than the limit; if every level is taller, the smallest one.
    let best = -1;
    levels.forEach((l, i) => { if ((l.height ?? 0) <= h && (best < 0 || (l.bitrate ?? 0) >= (levels[best].bitrate ?? 0))) best = i; });
    if (best < 0) best = levels.reduce((m, l, i) => ((l.height ?? 1e9) < (levels[m].height ?? 1e9) ? i : m), 0);
    cap = best;
  }
  const top = cap >= 0 ? cap : levels.reduce((m, l, i) => ((l.bitrate ?? 0) > (levels[m]?.bitrate ?? 0) ? i : m), 0);
  const start = pb.startQuality === 'highest' ? top : pb.startQuality === 'lowest' ? levels.reduce((m, l, i) => ((l.bitrate ?? 0) < (levels[m]?.bitrate ?? 0) ? i : m), 0) : undefined;
  return { cap, start };
}

/** mpegts.js config (the media data source's isLive is set separately from ctx.vod). */
export function mpegtsConfig(pb: PlaybackSettings, ctx: Ctx & { decoder: boolean }) {
  const prof = bufferProfile(pb);
  const p = BUFFER_PROFILES[prof];
  const live = !ctx.vod;
  return {
    enableWorker: true,
    // The stash groups small network reads before parsing; off only for the lowest latency.
    enableStashBuffer: prof !== 'low-latency',
    stashInitialSize: 128 * 1024, // small first read = fast first frame; mpegts.js grows it with throughput
    liveBufferLatencyChasing: live && p.chase,
    liveBufferLatencyMaxLatency: 2.5,
    liveBufferLatencyMinRemain: 0.8,
    // Gentle catch-up (10% faster, no skipping) only when far behind live.
    liveSync: live && !p.chase && p.syncAbove > 0,
    liveSyncMaxLatency: p.syncAbove || 1.2,
    liveSyncTargetLatency: Math.max(p.rebufferMax, 1),
    liveSyncPlaybackRate: 1.1,
    // Lazy loading aborts and re-requests with a Range: never for live, never for the decoder
    // (its stream can't resume mid-way); fine for direct movie files.
    lazyLoad: !live && !ctx.decoder,
    lazyLoadMaxDuration: 3 * 60,
    lazyLoadRecoverDuration: 60,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: live ? 40 : 3 * 60,
    autoCleanupMinBackwardDuration: live ? 20 : 2 * 60,
    fixAudioTimestampGap: true,
  };
}

const PRESETS = ['superfast', 'veryfast', 'faster', 'fast'] as const;
export type X264Preset = (typeof PRESETS)[number];
const PRESET_BY_LEVEL: Record<ComputerLevel, X264Preset> = { low: 'superfast', medium: 'veryfast', high: 'faster' };

/** What the desktop decoder should do for this stream (validated again in the main process). */
export function decoderOptions(pb: PlaybackSettings, m: Machine, ctx: Ctx): DecoderOptions {
  const level = resolveComputer(pb.computer, m);
  let preset = PRESET_BY_LEVEL[level];
  let height = maxHeight(pb);
  if (level === 'low' && (!height || height > 720)) height = 720; // keep up in real time on small CPUs
  if (ctx.compact) {
    // Multiview tiles: one notch cheaper, and no tile needs more than 720p.
    preset = PRESETS[Math.max(0, PRESETS.indexOf(preset) - 1)];
    if (!height || height > 720) height = 720;
  }
  const hw = pb.hwAccel === 'off' ? false : pb.hwAccel === 'on' ? true : !!m.hwEncoder;
  return {
    preset,
    maxHeight: height,
    deinterlace: pb.deinterlace,
    hw,
    lowLatency: bufferProfile(pb) === 'low-latency',
    ss: ctx.vod && ctx.startAt && ctx.startAt > 0 ? Math.floor(ctx.startAt * 10) / 10 : 0,
    // Movies: let ffmpeg run up to this far ahead of real time (a cushion that real-time pacing never builds).
    lead: ctx.vod ? (bufferProfile(pb) === 'max' ? 60 : bufferProfile(pb) === 'low-latency' ? 5 : 20) : 0,
  };
}

/** Plain-language labels for Settings → Playback. */
export const BUFFER_HELP: Record<BufferProfile, string> = {
  auto: 'Recommended. Starts fast; if the connection hiccups it builds a cushion so the next one doesn’t pause. Usually a few seconds behind live.',
  'low-latency': 'Closest to live (1–3 s behind). Pauses more often on a shaky connection. Good for fast, reliable connections.',
  balanced: 'A small cushion: a few seconds behind live, rides out short hiccups.',
  smooth: 'Fewer pauses: keeps a bigger cushion, about 10–20 s behind live.',
  max: 'Fewest pauses on a bad connection: waits for a large cushion, up to ~30 s behind live. Slower to start.',
};

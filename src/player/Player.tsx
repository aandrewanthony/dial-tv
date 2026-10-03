import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type Hls from 'hls.js';
import {
  AlertTriangle, Activity, Captions, Cpu, Expand, Gauge, Languages, Loader2, Maximize, Minimize, Pause, Play,
  PictureInPicture2, RotateCw, Volume2, VolumeX,
} from 'lucide-react';
import type { Channel } from '../types';
import { channelHeaders, desktop, isDesktop, type StreamInfo } from '../lib/net';
import { useApp } from '../store/app';
import { sniffStream, type Engine } from './detect';
import { isHttpUrl, redactUrl, splitUserinfo } from '../lib/url';

export interface PlayerHandle {
  togglePlay(): void;
  toggleMute(): void;
  volume(delta: number): void;
  fullscreen(): void;
  pip(): void;
  toggleStats(): void;
}

export interface StreamStats {
  resolution: string;
  bitrate: string;
  bandwidth: string;
  dropped: string;
  buffer: string;
  codecs: string;
  latency: string;
  engine: string;
  url: string;
}

type Status = 'loading' | 'playing' | 'paused' | 'buffering' | 'error';
interface Track { id: number; label: string }

const kbps = (b?: number) => (b ? (b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mbps` : `${Math.round(b / 1e3)} kbps`) : '—');

interface Props {
  channel: Channel;
  muted?: boolean;
  compact?: boolean;
  theater?: boolean;
  onTheater?: () => void;
  overlay?: React.ReactNode;
  onActivate?: () => void;
}

const mse = (t: string) => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(t);
/** 10-bit / 4:2:2 / 4:4:4 H.264: Chromium shows no picture, so it must be converted. */
export function highBitDepth(i: StreamInfo): boolean {
  if (i.pixFmt && !/^(yuvj?420p|nv12)$/.test(i.pixFmt)) return true;
  return /high 10|4:2:2|4:4:4|high 422|high 444/i.test(i.profile ?? '');
}
/** Can Chromium decode these codecs without the built-in decoder? */
export function directPlayable(i: StreamInfo): boolean {
  const v = i.video;
  const videoOk = !v || (v === 'h264' && !highBitDepth(i)) || (v === 'hevc' && (mse('video/mp4; codecs="hvc1.1.6.L120.90"') || mse('video/mp4; codecs="hev1.1.6.L120.90"')));
  const a = i.audio;
  const audioOk = !a || ['aac', 'mp3', 'opus'].includes(a) || (a === 'ac3' && mse('audio/mp4; codecs="ac-3"')) || (a === 'eac3' && mse('audio/mp4; codecs="ec-3"'));
  return videoOk && audioOk;
}

// Whether ffmpeg really exists (asked once per app run, shared by every player).
let decoderCheck: Promise<boolean> | undefined;
let decoderKnown: boolean | undefined;
const checkDecoder = () =>
  (decoderCheck ??= (desktop()?.decoder?.info() ?? Promise.resolve({ available: false }))
    .then((i) => !!i?.available, () => false)
    .then((ok) => (decoderKnown = ok)));
// Streams whose silent-failure check already passed (radio, silent feeds): don't re-check this session.
const verified = new Set<string>();
const clientError = (s?: number) => !!s && s >= 400 && s < 500;
type Mode = 'direct' | 'decoder';

const Player = forwardRef<PlayerHandle, Props>(function Player({ channel, muted: mutedProp, compact, theater, onTheater, overlay, onActivate }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [urlIndex, setUrlIndex] = useState(0);
  const [muted, setMuted] = useState(!!mutedProp);
  const [vol, setVol] = useState(1);
  const [levels, setLevels] = useState<Track[]>([]);
  const [level, setLevel] = useState(-1);
  const [audio, setAudio] = useState<Track[]>([]);
  const [audioId, setAudioId] = useState(0);
  const [subs, setSubs] = useState<Track[]>([]);
  const [subId, setSubId] = useState(-1);
  const [menu, setMenu] = useState<'quality' | 'audio' | 'subs' | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<StreamStats>();
  const [chrome, setChrome] = useState(true);
  const engineRef = useRef<string>('');
  const [engineLabel, setEngineLabel] = useState('');

  // Built-in decoder (desktop): converts formats Chromium can't play (MPEG-2, AC-3, E-AC-3, ...)
  // and opens protocols it can't (rtmp, rtsp, udp, ...).
  const decoderPref = useApp((s) => s.settings.decoder ?? 'auto');
  const rememberedDecoder = useApp((s) => (s.settings.decoderChannels ?? []).includes(channel.id));
  const [ffmpegOk, setFfmpegOk] = useState(decoderKnown ?? !!desktop()?.decoder);
  useEffect(() => {
    let live = true;
    void checkDecoder().then((ok) => live && setFfmpegOk(ok));
    return () => { live = false; };
  }, []);
  const decoderAvailable = ffmpegOk && !!desktop()?.decoder && decoderPref !== 'off';
  const initialMode = (): Mode => (decoderAvailable && (decoderPref === 'always' || rememberedDecoder) ? 'decoder' : 'direct');
  const [modeState, setMode] = useState<Mode>(initialMode);
  const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
  const rememberDecoder = (on: boolean) =>
    useApp.getState().update((st) => {
      const list = st.settings.decoderChannels ?? [];
      const next = on ? (list.includes(channel.id) ? list : [...list, channel.id]) : list.filter((x) => x !== channel.id);
      return { settings: { ...st.settings, decoderChannels: next } };
    });

  // Channel change: reset during render, so the attach effect never runs with the previous
  // channel's mode / fallback index.
  const [shownId, setShownId] = useState(channel.id);
  if (shownId !== channel.id) {
    setShownId(channel.id);
    setUrlIndex(0);
    setAttempt(0);
    setMode(initialMode());
    setStreamInfo(null);
  }

  const urls = [channel.url, ...(channel.fallbackUrls ?? [])];
  const url = urls[Math.min(urlIndex, urls.length - 1)];
  // rtmp/rtsp/udp/... only play through ffmpeg (even if the decoder is off for http streams).
  const needsDecoder = !isHttpUrl(url);
  const mode: Mode = needsDecoder ? 'decoder' : decoderAvailable ? modeState : 'direct';

  useEffect(() => setMuted(!!mutedProp), [mutedProp]);

  // Attach the right engine for the current URL. At most one provider connection is open at a
  // time: the first-bytes sniff closes before the player connects, and codecs are only probed
  // (by ffmpeg) after a direct failure or a silent stall, never alongside playback.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    let failed = false; // fail()/decoder switch happen at most once per run
    let destroy: (() => void) | undefined;
    let avail = decoderAvailable;
    let everPlayed = false;
    let reconnecting = false;
    let reconnects = 0;
    let netRetries = 0;
    let mediaRetries = 0;
    let expectVideo: boolean | undefined; // what the engine found in the stream
    let expectAudio: boolean | undefined;
    setStatus('loading');
    setError(undefined);
    setLevels([]);
    setAudio([]);
    setSubs([]);
    setLevel(-1);

    const headers = isDesktop() ? channelHeaders(channel) : {};

    /** Hand this channel to the built-in decoder (desktop, http(s) streams in direct mode). */
    const useDecoder = (remember: boolean) => {
      if (cancelled || failed || mode === 'decoder' || !avail || needsDecoder) return false;
      failed = true;
      if (remember) rememberDecoder(true);
      setMode('decoder');
      return true;
    };
    /** Next step after a failure: decoder (once), then the playlist owner's fallback URLs. */
    const fail = (msg: string, httpStatus?: number) => {
      if (cancelled || failed) return;
      // Direct playback failed: try converting before giving up. Even on a 4xx: a 403 is often a
      // browser-UA block that ffmpeg (VLC's UA) gets past; the decoder reports a real 4xx quickly.
      if (useDecoder(false)) return;
      failed = true;
      if (urlIndex < urls.length - 1) {
        setUrlIndex((i) => i + 1);
        setMode(initialMode());
        setStreamInfo(null);
        return;
      }
      setError(httpStatus ? `Stream returned HTTP ${httpStatus}` : msg);
      setStatus('error');
    };

    const startPlay = () => {
      v.play().catch((e: unknown) => {
        // Only an autoplay block falls back to muted; AbortError just means a newer load/zap won.
        if (cancelled || (e as Error)?.name !== 'NotAllowedError') return;
        v.muted = true;
        setMuted(true);
        v.play().catch(() => !cancelled && setStatus('paused'));
      });
    };
    // Native engine errors (.mp4/.mkv/.mp3, MSE decode errors) go through the same recovery path.
    const onMediaError = () => {
      if (hlsRef.current) return; // hls.js reports and recovers its own errors
      if (reconnecting || /empty src/i.test(v.error?.message ?? '')) return; // mpegts.js detaching during a reconnect
      fail(v.error?.message || 'Playback failed (unsupported format, offline, or blocked)');
    };
    let infoAsked = false;
    const onPlaying = () => {
      everPlayed = true;
      reconnecting = false;
      if (mode === 'decoder' && !infoAsked) {
        infoAsked = true; // Stream Health codecs from the decoder server's own probe
        void desktop()?.decoder?.infoFor?.(url).then((i) => { if (!cancelled && i) setStreamInfo(i); }, () => {});
      }
    };
    v.addEventListener('error', onMediaError);
    v.addEventListener('playing', onPlaying);

    const sniff = new AbortController();
    (async () => {
      avail = !!desktop()?.decoder && (await checkDecoder()) && (decoderPref !== 'off' || needsDecoder);
      if (cancelled) return;
      if (mode === 'decoder' && !avail) {
        if (needsDecoder) return fail(isDesktop() ? 'This stream type needs the built-in decoder (ffmpeg), which is not available' : 'This stream type (rtmp/rtsp/udp/...) only plays in the Dial TV desktop app');
        return; // decoder turned out to be missing: the re-render switches to direct playback
      }
      let playUrl = url;
      let kind: Engine;
      if (mode === 'decoder') {
        // ffmpeg gets the original URL (user:pass@ included) and the playlist headers.
        const u = await desktop()!.decoder!.url(url, headers);
        if (cancelled) return;
        if (!u) return fail('Built-in decoder is not available');
        playUrl = u;
        kind = 'mpegts';
      } else {
        if (isDesktop()) {
          // fetch()/XHR reject user:pass@ URLs: strip them and send Basic auth via the shell's header map,
          // which also applies the playlist UA/Referer/... to every request for this stream.
          const { url: clean, authorization } = splitUserinfo(url);
          playUrl = clean;
          await desktop()!.setStreamHeaders?.(clean, authorization ? { ...headers, Authorization: authorization } : headers);
          if (cancelled) return;
        }
        // Links without an extension (common in IPTV) are identified by their first bytes.
        const sn = await sniffStream(playUrl, sniff.signal);
        if (cancelled) return;
        if (sn.status) return fail(`Stream returned HTTP ${sn.status}`, sn.status);
        kind = sn.engine;
      }
      // Prefer hls.js (quality/audio/subtitle control + stats); fall back to native HLS where MSE is missing (iOS Safari).
      const HlsCtor = kind === 'hls' ? (await import('hls.js')).default : undefined;
      if (cancelled) return;
      if (kind === 'hls' && !HlsCtor?.isSupported() && v.canPlayType('application/vnd.apple.mpegurl')) {
        engineRef.current = 'Native HLS';
        setEngineLabel('native-hls');
        v.src = playUrl;
      } else if (kind === 'native') {
        engineRef.current = 'Native';
        setEngineLabel('native');
        v.src = playUrl;
      } else if (kind === 'hls') {
        if (!HlsCtor || !HlsCtor.isSupported()) return fail('HLS is not supported in this browser');
        const hls = new HlsCtor({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30 });
        hlsRef.current = hls;
        engineRef.current = `hls.js ${HlsCtor.version}`;
        setEngineLabel('hls');
        const E = HlsCtor.Events;
        hls.on(E.MANIFEST_PARSED, () => {
          setLevels(hls.levels.map((l, i) => ({ id: i, label: l.height ? `${l.height}p${l.bitrate ? ` · ${kbps(l.bitrate)}` : ''}` : kbps(l.bitrate) })));
          setLevel(hls.autoLevelEnabled ? -1 : hls.currentLevel);
        });
        hls.on(E.AUDIO_TRACKS_UPDATED, () => {
          setAudio(hls.audioTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Track ${i + 1}` })));
          setAudioId(hls.audioTrack);
        });
        hls.on(E.SUBTITLE_TRACKS_UPDATED, () => {
          setSubs(hls.subtitleTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Subs ${i + 1}` })));
          setSubId(hls.subtitleTrack);
        });
        hls.on(E.BUFFER_CODECS, (_e, data) => {
          expectVideo = !!(data.video || data.audiovideo);
          expectAudio = !!(data.audio || data.audiovideo);
        });
        hls.on(E.FRAG_LOADED, () => { netRetries = 0; }); // recovered: a later drop gets the full retry budget again
        let manifestLoaded = false;
        hls.on(E.MANIFEST_LOADED, () => { manifestLoaded = true; });
        hls.on(E.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
            mediaRetries++;
            hls.recoverMediaError();
          } else if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR && manifestLoaded && netRetries < 5 && !clientError(data.response?.code)) {
            // Mid-stream network drop: resume loading with backoff. (Manifest failures were already
            // retried by hls.js' load policy, so those fall through to the error/fallback path.)
            netRetries++;
            setStatus('buffering');
            setTimeout(() => !cancelled && hls.startLoad(), 1000 * 2 ** (netRetries - 1));
          } else {
            const code = data.response?.code || undefined;
            fail(data.details === 'manifestLoadError' && !code ? 'Could not load stream (offline, blocked, or CORS)' : `Playback error: ${data.details}`, code);
          }
        });
        hls.loadSource(playUrl);
        hls.attachMedia(v);
        destroy = () => {
          hls.destroy();
          hlsRef.current = null;
        };
      } else {
        const mpegts = (await import('mpegts.js')).default;
        if (cancelled) return;
        if (!mpegts.isSupported()) return fail('MPEG-TS playback not supported here');
        engineRef.current = mode === 'decoder' ? 'Built-in decoder (ffmpeg to H.264/AAC)' : `mpegts.js ${mpegts.version ?? ''}`;
        setEngineLabel(mode === 'decoder' ? 'decoder' : 'mpegts');
        type TsPlayer = ReturnType<typeof mpegts.createPlayer>;
        let player: TsPlayer | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const teardown = () => {
          const p = player;
          player = null;
          if (!p) return;
          try {
            p.pause();
            p.unload();
            p.detachMediaElement();
            p.destroy();
          } catch { /* already gone */ }
        };
        // Live TS (and the decoder's ffmpeg) can drop: reconnect with backoff instead of failing.
        const reconnect = (msg: string, httpStatus?: number) => {
          if (cancelled || failed) return;
          if (!everPlayed || clientError(httpStatus) || reconnects >= 5) return fail(msg, httpStatus);
          reconnects++;
          reconnecting = true;
          setStatus('buffering');
          teardown();
          timer = setTimeout(() => {
            if (cancelled) return;
            reconnecting = false; // the watchdog judges the new connection again
            open();
          }, 1000 * 2 ** (reconnects - 1));
        };
        const open = () => {
          const p = mpegts.createPlayer({ type: mode === 'direct' && playUrl.toLowerCase().includes('.flv') ? 'flv' : 'mpegts', isLive: true, url: playUrl }, { enableWorker: true, liveBufferLatencyChasing: true });
          player = p;
          p.attachMediaElement(v);
          p.on(mpegts.Events.ERROR, (type: string, detail: string, info?: { code?: number }) => {
            if (player !== p) return;
            const code = typeof info?.code === 'number' && info.code > 0 ? info.code : undefined;
            if (type === mpegts.ErrorTypes.MEDIA_ERROR) return fail(`Stream error: ${type} ${detail}`);
            reconnect(`Stream error: ${type} ${detail}`, code);
          });
          p.on(mpegts.Events.LOADING_COMPLETE, () => { if (player === p) reconnect('Stream ended'); }); // a live feed never "completes"
          p.on(mpegts.Events.MEDIA_INFO, (mi: { hasVideo?: boolean; hasAudio?: boolean }) => {
            expectVideo = mi.hasVideo;
            expectAudio = mi.hasAudio;
          });
          p.load();
          startPlay();
        };
        open();
        destroy = () => {
          clearTimeout(timer);
          teardown();
        };
        return;
      }
      startPlay();
    })().catch((e) => fail(String(e?.message ?? e)));

    /** Unknown codecs and no sound: stop playback, probe once (one connection), then decide. */
    const verifyWithProbe = async (sawVideo: boolean, sawAudio: boolean) => {
      failed = true;
      destroy?.();
      destroy = undefined;
      v.removeEventListener('error', onMediaError);
      v.removeAttribute('src');
      v.load();
      setStatus('loading');
      const i = await desktop()!.decoder!.probe(url, headers).catch(() => null);
      if (cancelled) return;
      if (i) setStreamInfo(i);
      // Decoder if Chromium can't decode the codecs, or if a track the stream has wasn't decoding.
      if (i && ((i.video || i.audio) && (!directPlayable(i) || (i.video && !sawVideo) || (i.audio && !sawAudio)))) {
        rememberDecoder(true);
        setMode('decoder');
        return;
      }
      verified.add(url);
      setAttempt((a) => a + 1); // play directly again, without the check
    };

    // Watchdog: some failures (blocked segments, dead TS feeds) never raise an error event.
    // If playback hasn't advanced, stop spinning and try the next step instead of buffering forever.
    // In direct mode on desktop, also catch *silent* failures: picture with no sound (AC-3) or
    // sound with no picture (MPEG-2) never raise errors, so check that both are really decoding.
    let lastT = -1;
    let stalledFor = 0;
    let playingFor = 0;
    let sustained = 0;
    let checked = verified.has(url);
    let vb0 = 0, ab0 = 0;
    const stallLimit = mode === 'decoder' ? 40 : decoderAvailable ? 15 : 25;
    const watchdog = setInterval(() => {
      if (cancelled || failed || v.paused) return;
      const advancing = v.currentTime !== lastT && v.readyState >= 3;
      lastT = v.currentTime;
      if (reconnecting) { stalledFor = 0; return; }
      stalledFor = advancing ? 0 : stalledFor + 5;
      sustained = advancing ? sustained + 5 : 0;
      if (sustained >= 30) { reconnects = 0; mediaRetries = 0; } // long healthy stretch: full retry budget again
      const media = v as HTMLVideoElement & { webkitVideoDecodedByteCount?: number; webkitAudioDecodedByteCount?: number };
      if (advancing && mode === 'direct' && avail && !checked) {
        playingFor += 5;
        const vb = media.webkitVideoDecodedByteCount ?? 0;
        const ab = media.webkitAudioDecodedByteCount ?? 0;
        if (playingFor === 5) { vb0 = vb; ab0 = ab; }
        if (playingFor >= 10) {
          checked = true;
          const videoOk = v.videoWidth > 0 && vb > vb0;
          const audioOk = ab > ab0;
          // Judge only what is known: an earlier ffmpeg probe of this stream, else what the engine parsed.
          // The engine can't see tracks it doesn't support (MPEG-2 video, AC-3 audio), so its "no track"
          // is NOT trusted: only a probe can say a stream is really audio-only or silent.
          const wantVideo = streamInfo ? !!streamInfo.video : expectVideo ? true : undefined;
          const wantAudio = streamInfo ? !!streamInfo.audio : expectAudio ? true : undefined;
          if (!videoOk && !audioOk) useDecoder(true);
          else if (!videoOk && wantVideo) useDecoder(true);
          else if (!audioOk && wantAudio) useDecoder(true);
          else if ((!videoOk && wantVideo === undefined) || (!audioOk && wantAudio === undefined)) void verifyWithProbe(videoOk, audioOk);
          else verified.add(url); // all good, or a probe-confirmed audio-only (radio) / silent feed
          if (failed) return;
        }
      }
      if (stalledFor >= stallLimit) {
        clearInterval(watchdog);
        fail(isDesktop()
          ? 'Stream is not sending video (offline, overloaded, or not available in your region)'
          : 'Stream is not sending video. In a browser this is usually the host blocking web playback (CORS); the desktop app avoids that.');
      }
    }, 5000);

    return () => {
      cancelled = true;
      sniff.abort();
      setEngineLabel('');
      clearInterval(watchdog);
      v.removeEventListener('error', onMediaError);
      v.removeEventListener('playing', onPlaying);
      destroy?.();
      v.removeAttribute('src');
      v.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, attempt, mode]);

  // Media element state
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const on = (ev: string, fn: () => void) => {
      v.addEventListener(ev, fn);
      return () => v.removeEventListener(ev, fn);
    };
    const offs = [
      on('playing', () => setStatus('playing')),
      on('pause', () => setStatus((s) => (s === 'error' ? s : 'paused'))),
      on('waiting', () => setStatus((s) => (s === 'error' ? s : 'buffering'))),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    v.volume = vol;
  }, [muted, vol]);

  // Stats sampling
  useEffect(() => {
    if (!showStats) return;
    const sample = () => {
      const v = videoRef.current;
      if (!v) return;
      const h = hlsRef.current;
      const lvl = h && h.currentLevel >= 0 ? h.levels[h.currentLevel] : undefined;
      const q = v.getVideoPlaybackQuality?.();
      let ahead = 0;
      for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) >= v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
      setStats({
        resolution: v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—',
        bitrate: kbps(lvl?.bitrate),
        bandwidth: kbps(h?.bandwidthEstimate),
        dropped: q ? `${q.droppedVideoFrames} / ${q.totalVideoFrames}` : '—',
        buffer: `${ahead.toFixed(1)} s`,
        codecs: streamInfo
          ? `${[streamInfo.video, streamInfo.audio].filter(Boolean).join(' + ')}${streamInfo.interlaced ? ' (interlaced)' : ''}${mode === 'decoder' ? ' → h264 + aac' : ''}`
          : lvl ? [lvl.videoCodec, lvl.audioCodec].filter(Boolean).join(', ') || '—' : '—',
        latency: h?.latency && lvl?.details?.live ? `${h.latency.toFixed(1)} s` : h && !lvl?.details?.live ? 'VOD' : '—',
        engine: engineRef.current,
        url: redactUrl(url),
      });
    };
    sample();
    const t = setInterval(sample, 1000);
    return () => clearInterval(t);
  }, [showStats, url, streamInfo, mode]);

  // Auto-hide chrome
  useEffect(() => {
    if (!chrome || compact) return;
    const t = setTimeout(() => setChrome(false), 3000);
    return () => clearTimeout(t);
  }, [chrome, compact, menu]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);
  const fullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);
  const pip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* not supported */
    }
  }, []);

  useImperativeHandle(ref, () => ({
    togglePlay,
    toggleMute: () => setMuted((m) => !m),
    volume: (d) => {
      setMuted(false);
      setVol((x) => Math.max(0, Math.min(1, x + d)));
    },
    fullscreen,
    pip,
    toggleStats: () => setShowStats((s) => !s),
  }), [togglePlay, fullscreen, pip]);

  const retry = () => {
    setUrlIndex(0);
    setMode(initialMode());
    setAttempt((a) => a + 1);
  };

  return (
    <div
      ref={wrapRef}
      className={`player ${compact ? 'compact' : ''} ${chrome || status !== 'playing' ? 'chrome' : ''}`}
      data-engine={engineLabel}
      data-mode={mode}
      data-status={status}
      onMouseMove={() => setChrome(true)}
      onClick={onActivate}
    >
      <video ref={videoRef} playsInline autoPlay muted={muted} onDoubleClick={fullscreen} onClick={compact ? undefined : togglePlay} />
      {overlay}
      {(status === 'loading' || status === 'buffering') && (
        <div className="playerState"><Loader2 className="spin" /><span>{mode === 'decoder' && status === 'loading' ? `Converting${streamInfo ? ` ${[streamInfo.video, streamInfo.audio].filter(Boolean).join(' / ').toUpperCase()}` : ''} with the built-in decoder…` : status === 'loading' ? `Tuning ${channel.name}…` : 'Buffering…'}</span></div>
      )}
      {status === 'error' && (
        <div className="playerState error">
          <AlertTriangle />
          <b>Can’t play {channel.name}</b>
          <span>{error}</span>
          <button onClick={(e) => { e.stopPropagation(); retry(); }}><RotateCw /> Retry</button>
        </div>
      )}
      {showStats && stats && (
        <div className="stats" onClick={(e) => e.stopPropagation()}>
          <b>STREAM HEALTH</b>
          {Object.entries(stats).map(([k, v]) => <div key={k}><span>{k}</span><code>{v}</code></div>)}
        </div>
      )}
      {!compact && (
        <div className="controls" onClick={(e) => e.stopPropagation()}>
          <button onClick={togglePlay} title="Play/Pause (Space)">{status === 'paused' ? <Play /> : <Pause />}</button>
          <button onClick={() => setMuted((m) => !m)} title="Mute (M)">{muted || vol === 0 ? <VolumeX /> : <Volume2 />}</button>
          <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : vol} onChange={(e) => { setMuted(false); setVol(+e.target.value); }} aria-label="Volume" />
          <span className="spacer" />
          {levels.length > 1 && <button className={menu === 'quality' ? 'on' : ''} onClick={() => setMenu(menu === 'quality' ? null : 'quality')} title="Quality"><Gauge /></button>}
          {audio.length > 1 && <button className={menu === 'audio' ? 'on' : ''} onClick={() => setMenu(menu === 'audio' ? null : 'audio')} title="Audio"><Languages /></button>}
          {subs.length > 0 && <button className={menu === 'subs' ? 'on' : ''} onClick={() => setMenu(menu === 'subs' ? null : 'subs')} title="Subtitles"><Captions /></button>}
          {decoderAvailable && (
            <button
              className={mode === 'decoder' ? 'on' : ''}
              title={mode === 'decoder' ? 'Built-in decoder ON for this channel (click to play directly)' : 'Use the built-in decoder for this channel'}
              onClick={() => { const on = mode !== 'decoder'; rememberDecoder(on); setMode(on ? 'decoder' : 'direct'); setAttempt((a) => a + 1); }}
            ><Cpu /></button>
          )}
          <button className={showStats ? 'on' : ''} onClick={() => setShowStats((s) => !s)} title="Stream health (I)"><Activity /></button>
          <button onClick={pip} title="Picture-in-picture (P)"><PictureInPicture2 /></button>
          {onTheater && <button onClick={onTheater} title="Theater (T)">{theater ? <Minimize /> : <Expand />}</button>}
          <button onClick={fullscreen} title="Fullscreen (F)"><Maximize /></button>
          {menu && (
            <div className="menu">
              {menu === 'quality' && [{ id: -1, label: 'Auto' }, ...levels].map((l) => (
                <button key={l.id} className={level === l.id ? 'on' : ''} onClick={() => { if (hlsRef.current) hlsRef.current.currentLevel = l.id; setLevel(l.id); setMenu(null); }}>{l.label}</button>
              ))}
              {menu === 'audio' && audio.map((t) => (
                <button key={t.id} className={audioId === t.id ? 'on' : ''} onClick={() => { if (hlsRef.current) hlsRef.current.audioTrack = t.id; setAudioId(t.id); setMenu(null); }}>{t.label}</button>
              ))}
              {menu === 'subs' && [{ id: -1, label: 'Off' }, ...subs].map((t) => (
                <button key={t.id} className={subId === t.id ? 'on' : ''} onClick={() => { if (hlsRef.current) { hlsRef.current.subtitleTrack = t.id; hlsRef.current.subtitleDisplay = t.id >= 0; } setSubId(t.id); setMenu(null); }}>{t.label}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default Player;

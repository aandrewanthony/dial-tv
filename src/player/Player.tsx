import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type Hls from 'hls.js';
import {
  AlertTriangle, Activity, Captions, Cpu, Expand, Gauge, Languages, Loader2, Maximize, Minimize, Pause, Play,
  PictureInPicture2, RotateCw, Volume2, VolumeX,
} from 'lucide-react';
import type { Channel } from '../types';
import { desktop, isDesktop, type StreamInfo } from '../lib/net';
import { useApp } from '../store/app';
import { detectEngine, type Engine } from './detect';
import { redactUrl } from '../lib/url';

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
/** Can Chromium decode these codecs without the built-in decoder? */
export function directPlayable(i: StreamInfo): boolean {
  const v = i.video;
  const videoOk = !v || v === 'h264' || (v === 'hevc' && (mse('video/mp4; codecs="hvc1.1.6.L120.90"') || mse('video/mp4; codecs="hev1.1.6.L120.90"')));
  const a = i.audio;
  const audioOk = !a || ['aac', 'mp3', 'opus'].includes(a) || (a === 'ac3' && mse('audio/mp4; codecs="ac-3"')) || (a === 'eac3' && mse('audio/mp4; codecs="ec-3"'));
  return videoOk && audioOk;
}

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

  // Built-in decoder (desktop): converts formats Chromium can't play (MPEG-2, AC-3, E-AC-3, ...).
  const decoderPref = useApp((s) => s.settings.decoder ?? 'auto');
  const rememberedDecoder = useApp((s) => (s.settings.decoderChannels ?? []).includes(channel.id));
  const decoderAvailable = !!desktop()?.decoder && decoderPref !== 'off';
  const initialMode = (): 'direct' | 'decoder' => (decoderAvailable && (decoderPref === 'always' || rememberedDecoder) ? 'decoder' : 'direct');
  const [mode, setMode] = useState<'direct' | 'decoder'>(initialMode);
  const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
  const rememberDecoder = (on: boolean) =>
    useApp.getState().update((st) => {
      const list = st.settings.decoderChannels ?? [];
      const next = on ? (list.includes(channel.id) ? list : [...list, channel.id]) : list.filter((x) => x !== channel.id);
      return { settings: { ...st.settings, decoderChannels: next } };
    });

  const urls = [channel.url, ...(channel.fallbackUrls ?? [])];
  const url = urls[Math.min(urlIndex, urls.length - 1)];

  useEffect(() => setMuted(!!mutedProp), [mutedProp]);
  useEffect(() => {
    setUrlIndex(0);
    setAttempt(0);
    setMode(initialMode());
    setStreamInfo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  // Attach the right engine for the current URL.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    let destroy: (() => void) | undefined;
    let retries = 0;
    setStatus('loading');
    setError(undefined);
    setLevels([]);
    setAudio([]);
    setSubs([]);
    setLevel(-1);

    const ua = isDesktop() ? channel.userAgent : undefined;
    const ref = isDesktop() ? channel.referrer : undefined;
    let switched = false;
    /** Hand this channel to the built-in decoder (desktop only). */
    const useDecoder = (remember: boolean) => {
      if (cancelled || switched || mode === 'decoder' || !decoderAvailable) return false;
      switched = true;
      if (remember) rememberDecoder(true);
      setMode('decoder');
      return true;
    };

    const fail = (msg: string) => {
      if (cancelled) return;
      if (useDecoder(false)) return; // direct playback failed: try converting before giving up
      if (urlIndex < urls.length - 1) {
        setUrlIndex((i) => i + 1); // try the playlist owner's fallback URL
        return;
      }
      setError(msg);
      setStatus('error');
    };

    const probe = new AbortController();
    let info: StreamInfo | null = null;
    if (decoderAvailable) {
      // Check the stream's codecs (in parallel with playback). In direct mode, switch to the
      // decoder if Chromium can't decode them; in decoder mode this just fills in Stream Health.
      void desktop()!.decoder!.probe(url, ua, ref).then((i) => {
        if (cancelled || !i) return;
        info = i;
        setStreamInfo(i);
        if (mode === 'direct' && !directPlayable(i)) useDecoder(true);
      });
    }
    (async () => {
      let playUrl = url;
      let kind: Engine;
      if (mode === 'decoder') {
        const u = await desktop()!.decoder!.url(url, ua, ref);
        if (cancelled) return;
        if (!u) return fail('Built-in decoder is not available');
        playUrl = u;
        kind = 'mpegts';
      } else {
        // Links without an extension (common in IPTV) are identified by their first bytes.
        kind = await detectEngine(url, probe.signal);
      }
      if (cancelled) return;
      // Prefer hls.js (quality/audio/subtitle control + stats); fall back to native HLS where MSE is missing (iOS Safari).
      const HlsCtor = kind === 'hls' ? (await import('hls.js')).default : undefined;
      if (cancelled) return;
      if (kind === 'hls' && !HlsCtor?.isSupported() && v.canPlayType('application/vnd.apple.mpegurl')) {
        engineRef.current = 'Native HLS';
        setEngineLabel('native-hls');
        v.src = url;
      } else if (kind === 'hls' || kind === 'native') {
        if (kind === 'native') {
          engineRef.current = 'Native';
          setEngineLabel('native');
          v.src = url;
        } else {
          if (!HlsCtor || !HlsCtor.isSupported()) return fail('HLS is not supported in this browser');
          // Desktop app: pass the playlist's per-channel User-Agent / Referer (the shell swaps these in).
          const hls = new HlsCtor({
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 30,
            ...(ua || ref ? { xhrSetup: (xhr: XMLHttpRequest) => { if (ua) xhr.setRequestHeader('X-Dial-UA', ua); if (ref) xhr.setRequestHeader('X-Dial-Referer', ref); } } : {}),
          });
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
          let manifestLoaded = false;
          hls.on(E.MANIFEST_LOADED, () => { manifestLoaded = true; });
          hls.on(E.ERROR, (_e, data) => {
            if (!data.fatal) return;
            if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && retries < 2) {
              retries++;
              hls.recoverMediaError();
            } else if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR && manifestLoaded && retries < 3) {
              // Mid-stream network drop: resume loading with backoff. (Manifest failures were already
              // retried by hls.js' load policy, so those fall through to the error/fallback path.)
              retries++;
              setStatus('buffering');
              setTimeout(() => !cancelled && hls.startLoad(), 1000 * 2 ** retries);
            } else {
              const code = data.response?.code;
              fail(code ? `Stream returned HTTP ${code}` : data.details === 'manifestLoadError' ? 'Could not load stream (offline, blocked, or CORS)' : `Playback error: ${data.details}`);
            }
          });
          hls.loadSource(url);
          hls.attachMedia(v);
          destroy = () => {
            hls.destroy();
            hlsRef.current = null;
          };
        }
      } else {
        const mpegts = (await import('mpegts.js')).default;
        if (cancelled) return;
        if (!mpegts.isSupported()) return fail('MPEG-TS playback not supported here');
        const p = mpegts.createPlayer({ type: mode === 'direct' && url.toLowerCase().includes('.flv') ? 'flv' : 'mpegts', isLive: true, url: playUrl }, { enableWorker: true, liveBufferLatencyChasing: true });
        engineRef.current = mode === 'decoder' ? 'Built-in decoder (ffmpeg to H.264/AAC)' : `mpegts.js ${mpegts.version ?? ''}`;
        setEngineLabel(mode === 'decoder' ? 'decoder' : 'mpegts');
        p.attachMediaElement(v);
        p.on(mpegts.Events.ERROR, (type: string, detail: string) => fail(`Stream error: ${type} ${detail}`));
        p.load();
        destroy = () => {
          p.pause();
          p.unload();
          p.detachMediaElement();
          p.destroy();
        };
      }
      v.play().catch(() => {
        // Autoplay with sound may be blocked: fall back to muted autoplay.
        v.muted = true;
        setMuted(true);
        v.play().catch(() => setStatus('paused'));
      });
    })().catch((e) => fail(String(e?.message ?? e)));

    // Watchdog: some failures (blocked segments, dead TS feeds) never raise an error event.
    // If playback hasn't advanced, stop spinning and offer Retry instead of buffering forever.
    // In direct mode on desktop, also catch *silent* failures: picture with no sound (AC-3) or
    // sound with no picture (MPEG-2) never raise errors, so check that both are really decoding.
    let lastT = -1;
    let stalledFor = 0;
    let playingFor = 0;
    let vb0 = 0, ab0 = 0;
    const stallLimit = mode === 'decoder' ? 40 : decoderAvailable ? 15 : 25;
    const watchdog = setInterval(() => {
      if (cancelled || v.paused) return;
      const advancing = v.currentTime !== lastT && v.readyState >= 3;
      lastT = v.currentTime;
      stalledFor = advancing ? 0 : stalledFor + 5;
      const media = v as HTMLVideoElement & { webkitVideoDecodedByteCount?: number; webkitAudioDecodedByteCount?: number };
      if (advancing && mode === 'direct' && decoderAvailable) {
        playingFor += 5;
        const vb = media.webkitVideoDecodedByteCount ?? 0;
        const ab = media.webkitAudioDecodedByteCount ?? 0;
        if (playingFor === 5) { vb0 = vb; ab0 = ab; }
        if (playingFor >= 10) {
          const noPicture = (info?.video || !info) && (v.videoWidth === 0 || vb <= vb0);
          const noSound = info?.audio && ab <= ab0;
          if (noPicture || noSound) { clearInterval(watchdog); useDecoder(true); return; }
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
      probe.abort();
      setEngineLabel('');
      clearInterval(watchdog);
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
      on('error', () => {
        if (!hlsRef.current) {
          setStatus('error');
          setError(v.error?.message || 'Playback failed (unsupported format, offline, or blocked)');
        }
      }),
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

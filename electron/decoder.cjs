// Built-in decoder: converts streams Chromium can't play (MPEG-2 video, AC-3/E-AC-3/MP2 audio,
// HEVC on machines without HEVC support, 10-bit H.264) and protocols it can't open (rtmp, rtsp,
// udp, mms, srt, ...) into H.264 + AAC MPEG-TS on the fly with ffmpeg, served to the player
// from a token-protected server on 127.0.0.1.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const TOKEN = crypto.randomBytes(16).toString('hex');
const MAX_SESSIONS = 6; // multiview (4) + headroom
const PROBE_TTL = 10 * 60 * 1000;
const MAX_PROBES = 2; // concurrent dial:probe requests from the renderer
const VLC_UA = 'VLC/3.0.21 LibVLC/3.0.21';
const sessions = new Set();
let port = 0;

// Inputs VLC accepts from a playlist. mms:// is opened as mmsh:// (ffmpeg has no plain "mms").
const PROTOCOLS = new Set(['http', 'https', 'rtmp', 'rtmps', 'rtsp', 'rtsps', 'rtp', 'udp', 'mms', 'mmsh', 'mmst', 'srt']);
// Everything ffmpeg may open, including nested opens (HLS segments, redirects): never file:, concat:, data:, ...
const PROTOCOL_WHITELIST = 'http,https,tcp,tls,crypto,hls,udp,rtp,rtmp,rtmps,rtsp,srt,mmsh,mmst';

function ffmpegPath(app) {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg', exe);
  return require('ffmpeg-static');
}

const protocolOf = (u) => (/^([a-z][a-z0-9+.-]*):/i.exec(u)?.[1] ?? '').toLowerCase();
const isHttp = (u) => /^https?:\/\//i.test(u);

/** Validate a stream URL for ffmpeg; returns the URL to open or null. udp://@host:port is kept as is. */
function normalizeSource(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /[\s\0]/.test(s) || !/^[a-z]+:\/\/./i.test(s)) return null;
  const p = protocolOf(s);
  if (!PROTOCOLS.has(p)) return null;
  return p === 'mms' ? `mmsh${s.slice(3)}` : s;
}

/** No CR/LF/NUL in anything that becomes an HTTP header line. */
const cleanHeader = (v) => (typeof v === 'string' ? v.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 4096) : '');
const HOP_HEADERS = /^(host|content-length|connection|transfer-encoding|upgrade|te|keep-alive|proxy-.*)$/i;

/** Split a header map into ffmpeg's -user_agent value and a CRLF-joined -headers block. */
function splitHeaders(headers) {
  let ua = '';
  const lines = [];
  for (const [k, v] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    const name = String(k).trim();
    const val = cleanHeader(v);
    if (!val || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name) || HOP_HEADERS.test(name)) continue;
    if (/^user-agent$/i.test(name)) ua = val;
    else lines.push(`${name}: ${val}\r\n`);
  }
  return { ua, extra: lines.join('') };
}

function inputArgs(url, headers, loglevel = 'error') {
  const a = ['-hide_banner', '-nostdin', '-loglevel', loglevel, '-protocol_whitelist', PROTOCOL_WHITELIST];
  const p = protocolOf(url);
  if (isHttp(url)) {
    a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000');
    const { ua, extra } = splitHeaders(headers);
    a.push('-user_agent', ua || VLC_UA);
    if (extra) a.push('-headers', extra);
  } else if (p === 'rtsp' || p === 'rtsps') {
    a.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
  } else if (p === 'udp' || p === 'rtp') {
    a.push('-timeout', '10000000');
    if (p === 'udp') a.push('-overrun_nonfatal', '1');
  } else {
    a.push('-rw_timeout', '15000000'); // rtmp(s), mmsh/mmst, srt
  }
  a.push('-fflags', '+genpts+discardcorrupt', '-i', url);
  return a;
}

/** Upstream HTTP error status reported by ffmpeg ("HTTP error 404 ...", "Server returned 403 ..."), else null. */
function parseHttpStatus(stderr) {
  const m = /HTTP error (\d{3})/.exec(stderr) || /Server returned (\d{3})/.exec(stderr);
  if (m) return +m[1];
  if (/Server returned 4XX/.test(stderr)) return 400;
  if (/Server returned 5XX/.test(stderr)) return 502;
  return null;
}

/** Stream info from ffmpeg's stderr: codecs, profile, pixel format, interlacing, size. */
function parseProbe(stderr) {
  const v = /Stream #\d+:\d+[^:]*: Video: (\w+)([^\n]*)/.exec(stderr);
  const a = /Stream #\d+:\d+[^:]*: Audio: (\w+)([^\n]*)/.exec(stderr);
  if (!v && !a) return null;
  const vrest = v?.[2] ?? '';
  const profile = /^\s*\(([^)[\]/]+)\)/.exec(vrest)?.[1] ?? null;
  const pixFmt = /,\s*((?:yuvj?|yuva|nv|p0|gray|rgb|bgr|gbr)\w*)/.exec(vrest)?.[1] ?? null;
  return {
    video: v?.[1] ?? null,
    audio: a?.[1] ?? null,
    interlaced: !!v && /top first|bottom first|\btff\b|\bbff\b|interlaced/i.test(vrest),
    resolution: v ? (/(\d{3,4})x(\d{3,4})/.exec(vrest)?.slice(1, 3).join('x') ?? null) : null,
    pixFmt,
    profile,
    // Movies / recordings have a fixed length; live channels report "Duration: N/A".
    duration: (() => {
      const d = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr);
      const secs = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0;
      return secs > 0 ? secs : null;
    })(),
  };
}

/** Chromium only decodes 8-bit 4:2:0 H.264; anything else (MPEG-2, HEVC, 10-bit, 4:2:2) is re-encoded. */
function needsVideoTranscode(info) {
  if (info?.video !== 'h264') return true;
  if (info.pixFmt && !/^(yuvj?420p|nv12)$/.test(info.pixFmt)) return true;
  return /high 10|4:2:2|4:4:4|high 422|high 444/i.test(info.profile ?? '');
}

const SECRET_PARAMS = /^(user(name)?|pass(word)?|token|key|api_?key|auth|sig(nature)?|secret|session)$/i;

/** Hide credentials (user:pass@, secret query params, Xtream /live/user/pass/ paths) before logging. */
function redactUrl(raw) {
  let s = String(raw).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1***@');
  s = s.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/\s]*)\/(live|movie|series|timeshift)\/[^/\s]+\/[^/\s]+\//i, '$1/$2/***/***/');
  s = s.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/\s]*)\/[^/\s]+\/[^/\s]+\/(\d+(\.\w+)?)(?=$|[?#])/i, '$1/***/***/$2'); // http://host/user/pass/123
  return s.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (m, sep, k) => (SECRET_PARAMS.test(k) ? `${sep}${k}=***` : m));
}
const redactText = (t) => String(t).replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, (m) => redactUrl(m));

/**
 * Inspect a stream with ffmpeg (no output file → prints stream info and exits).
 * Resolves { info, status } where status is an upstream HTTP error, if any.
 */
function probe(bin, url, headers, { timeoutMs = 15000, signal } = {}) {
  return new Promise((resolve) => {
    const args = inputArgs(url, headers, 'info');
    args.splice(args.indexOf('-i'), 0, '-analyzeduration', '4000000', '-probesize', '4000000');
    let p;
    try {
      p = spawn(bin, args, { windowsHide: true });
    } catch {
      return resolve({ info: null, status: null });
    }
    let err = '';
    const kill = () => { if (p.exitCode === null) p.kill('SIGKILL'); };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill);
    p.stderr?.on('data', (d) => { err += d; if (err.length > 200000) kill(); });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ info: parseProbe(err), status: parseHttpStatus(err) });
    };
    p.on('error', finish);
    p.on('close', finish);
  });
}

// ---- Conversion options (from the renderer's Settings → Playback, see src/player/tuning.ts) ----
const PRESETS = ['superfast', 'veryfast', 'faster', 'fast'];
const HEIGHTS = [0, 480, 720, 1080, 2160];
const DEFAULT_OPTS = Object.freeze({ preset: 'veryfast', maxHeight: 0, deinterlace: 'auto', hw: false, lowLatency: false, ss: 0, lead: 0 });

/** Whitelist the renderer's options; anything unknown falls back to the defaults. */
function sanitizeOptions(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    preset: PRESETS.includes(o.preset) ? o.preset : DEFAULT_OPTS.preset,
    maxHeight: HEIGHTS.includes(o.maxHeight) ? o.maxHeight : 0,
    deinterlace: ['auto', 'on', 'off'].includes(o.deinterlace) ? o.deinterlace : 'auto',
    hw: o.hw === true,
    lowLatency: o.lowLatency === true,
    ss: Math.round(num(o.ss, 0, 7 * 24 * 3600, 0) * 10) / 10,
    lead: Math.round(num(o.lead, 0, 120, 0)),
  };
}

// Hardware H.264 encoders worth trying per platform (first one that test-encodes wins).
const HW_CANDIDATES = { win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'], darwin: ['h264_videotoolbox'], linux: ['h264_nvenc'] };

/** Target / peak bitrate (kbit/s) for an output height. */
function rateFor(height) {
  if (height && height <= 480) return [2000, 3000];
  if (height && height <= 720) return [4000, 6000];
  if (height && height > 1080) return [16000, 25000];
  return [6500, 10000];
}

/** Video encoder arguments: libx264 (preset from the computer level) or a hardware encoder. */
function videoEncoderArgs(encoder, o, height) {
  const [target, peak] = rateFor(height);
  const vbv = ['-maxrate', `${peak}k`, '-bufsize', `${peak * 2}k`];
  const gop = ['-g', '60', '-keyint_min', '30'];
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', o.lowLatency ? 'll' : 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', `${target}k`, ...vbv, ...gop, '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', `${target}k`, ...vbv, ...gop, '-profile:v', 'high', '-pix_fmt', 'nv12'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'vbr_peak', '-b:v', `${target}k`, ...vbv, ...gop, '-profile:v', 'high', '-pix_fmt', 'nv12'];
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', `${target}k`, ...vbv, ...gop, '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
    default:
      // zerolatency (no B-frames / lookahead) only when the viewer asked for low latency: it costs quality.
      return ['-c:v', 'libx264', '-preset', o.preset, ...(o.lowLatency ? ['-tune', 'zerolatency'] : []), '-crf', '21', ...vbv, ...gop,
        '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
  }
}

/** Test-encode a tiny generated clip with each candidate; resolves the first that works, else null. */
function detectHwEncoder(bin, platform = process.platform, timeoutMs = 8000) {
  const tryOne = (enc) => new Promise((resolve) => {
    let p;
    try {
      p = spawn(bin, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-frames:v', '15',
        ...videoEncoderArgs(enc, DEFAULT_OPTS, 720), '-f', 'null', '-'], { windowsHide: true });
    } catch { return resolve(false); }
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
  return (async () => {
    for (const enc of HW_CANDIDATES[platform] ?? []) if (await tryOne(enc)) return enc;
    return null;
  })();
}

/**
 * ffmpeg args that turn any input into browser-playable H.264/AAC MPEG-TS.
 * opts: sanitizeOptions() result; encoder: hardware encoder to use (null/undefined = libx264).
 */
function transcodeArgs(url, headers, info, opts, encoder) {
  const o = { ...DEFAULT_OPTS, ...(opts ?? {}) };
  const a = inputArgs(url, headers, 'warning'); // warnings include upstream "HTTP error 4xx"
  const before = (...x) => a.splice(a.indexOf('-i'), 0, ...x);
  const movie = !!info?.duration;
  if (movie && o.ss > 0) before('-ss', String(o.ss)); // input seeking: fast, starts at the keyframe before ss
  // Movies: never convert a 2-hour file all at once. With a lead, the server paces the output
  // (up to `lead` seconds ahead of real time); without one, ffmpeg reads at real-time pace.
  if (movie && !o.lead) before('-re');
  if (movie && o.lead) before('-progress', 'pipe:2', '-stats_period', '0.5'); // out_time for the pacer
  if (!movie && info) {
    // Live, codecs already known from the probe: don't spend another 5 s analysing before the first frame.
    before('-probesize', '1500000', '-analyzeduration', '1500000', '-thread_queue_size', '1024');
  }
  a.push('-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn');
  const interlaced = !!info?.interlaced || info?.video === 'mpeg2video';
  if (!needsVideoTranscode(info) && !(o.deinterlace === 'on' && info?.interlaced)) {
    a.push('-c:v', 'copy');
  } else {
    const vf = [];
    if (o.deinterlace === 'on') vf.push('yadif=0:-1:0'); // every frame
    else if (o.deinterlace === 'auto' && interlaced) vf.push('yadif=0:-1:1'); // frames marked interlaced
    if (o.maxHeight) vf.push(`scale=-2:min(ih\\,${o.maxHeight})`);
    if (vf.length) a.push('-vf', vf.join(','));
    const h = o.maxHeight || +(info?.resolution?.split('x')[1] ?? 0) || 1080;
    a.push(...videoEncoderArgs(encoder, o, h));
  }
  a.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
  a.push('-f', 'mpegts', '-mpegts_flags', '+resend_headers');
  if (o.lowLatency) a.push('-flush_packets', '1');
  a.push('pipe:1');
  return a;
}

function parseHeaderParam(s) {
  try {
    const h = JSON.parse(s || '{}');
    return h && typeof h === 'object' && !Array.isArray(h) ? h : {};
  } catch {
    return {};
  }
}

function start(app, ipcMain) {
  const bin = ffmpegPath(app);
  const available = !!bin && fs.existsSync(bin);
  // Hardware encoder: tested once, a few seconds after startup (doesn't delay the first channel).
  let hwEncoder = null;
  let hwChecked = !available;
  let hwBroken = false; // it failed for real once: libx264 for the rest of this run
  let hwReady = Promise.resolve(null);
  if (available) {
    hwReady = new Promise((r) => setTimeout(r, 2500)).then(() => detectHwEncoder(bin)).then((enc) => {
      hwEncoder = enc;
      hwChecked = true;
      console.log(`[decoder] hardware encoder: ${enc ?? 'none (libx264)'}`);
      return enc;
    }, () => { hwChecked = true; return null; });
  }
  const probeCache = new Map(); // url → { info, at }
  const inflight = new Map(); // url → Promise<{ info, status }>
  let active = 0; // reserved decoder slots (probe + transcode)

  const cached = (src) => {
    const c = probeCache.get(src);
    if (c && Date.now() - c.at < PROBE_TTL) return c.info;
    if (c) probeCache.delete(src);
    return undefined;
  };
  const remember = (src, r) => {
    if (r?.info) probeCache.set(src, { info: r.info, at: Date.now() });
    if (probeCache.size > 200) probeCache.delete(probeCache.keys().next().value);
  };
  /** One probe per URL at a time; later callers share the running one. */
  const runProbe = (src, headers, signal) => {
    if (inflight.has(src)) return inflight.get(src);
    const pr = probe(bin, src, headers, { signal }).then((r) => { remember(src, r); return r; })
      .finally(() => inflight.delete(src));
    inflight.set(src, pr);
    return pr;
  };

  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/stream' || u.searchParams.get('t') !== TOKEN) { res.writeHead(403); return res.end(); }
    if (!available) { res.writeHead(503, cors); return res.end('ffmpeg not available'); }
    const src = normalizeSource(u.searchParams.get('u'));
    if (!src) { res.writeHead(400, cors); return res.end(); }
    if (active >= MAX_SESSIONS) { res.writeHead(503, cors); return res.end('too many decoders'); }
    active++; // reserve the slot now: the probe below is async
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    const headers = parseHeaderParam(u.searchParams.get('h'));
    const opts = sanitizeOptions(parseHeaderParam(u.searchParams.get('o')));

    // Watch for the client going away *before* awaiting anything.
    let closed = false;
    let ff;
    const probeCtl = new AbortController();
    const onClose = () => {
      closed = true;
      probeCtl.abort();
      if (ff && ff.exitCode === null) ff.kill('SIGKILL');
    };
    req.on('close', onClose);
    res.on('close', onClose);

    let info = cached(src);
    if (info === undefined) {
      const r = inflight.has(src)
        ? await inflight.get(src)
        : await runProbe(src, headers, probeCtl.signal);
      info = r.info;
      // Dead link (e.g. 404): answer fast so the player moves to the next fallback URL.
      if (!info && r.status && !closed) { release(); res.writeHead(r.status >= 400 && r.status < 500 ? r.status : 502, cors); return res.end(); }
    }
    if (closed || res.destroyed) return release();
    // Hardware encoding wanted: wait for the startup test if it's still running (first seconds only).
    if (opts.hw && !hwChecked) await hwReady;
    if (closed || res.destroyed) return release();

    // Like VLC, retry once when the server refuses or drops the first connection attempt
    // (busy single-viewer servers, RTMP/RTSP servers restarting); otherwise report the failure.
    // A hardware encoder that fails before any output falls back to libx264 straight away.
    const launch = (attempt, useHw) => {
      const encoder = useHw ? hwEncoder : null;
      try {
        ff = spawn(bin, transcodeArgs(src, headers, info, opts, encoder), { windowsHide: true });
      } catch (e) {
        console.error('[decoder] could not start ffmpeg:', e?.code || e?.message);
        release();
        res.writeHead(502, cors);
        return res.end();
      }
      const proc = ff;
      sessions.add(proc);
      let stderr = '';
      let upstream = null;
      let started = false;
      let done = false;
      // Movie pacing: ffmpeg may run `lead` seconds ahead of real time, then waits (backpressure).
      let outTime = 0, firstAt = 0, gated = false, draining = false, pacer;
      const flow = () => { if (!gated && !draining && !proc.stdout.destroyed) proc.stdout.resume(); };
      const finish = (code) => {
        if (done) return;
        done = true;
        clearInterval(pacer);
        sessions.delete(proc);
        const encoderFailed = /error while opening encoder|error initializing output|nvenc|qsv|amf|videotoolbox|no capable devices|cannot load|device/i.test(stderr);
        if (!started && !closed && !res.destroyed && encoder && !upstream && encoderFailed) {
          hwBroken = true;
          console.error(`[decoder] ${encoder} failed, using libx264:`, redactText(stderr.trim().split('\n').slice(-2).join(' | ')));
          return launch(attempt, false);
        }
        const transient = /connection refused|connection reset|connection timed out|end of file|i\/o error/i.test(stderr);
        if (!started && !closed && !res.destroyed && attempt === 0 && !upstream && transient) {
          return setTimeout(() => { if (!closed && !res.destroyed) launch(1, useHw); else release(); }, 1000);
        }
        release();
        if (!started && !res.headersSent && !res.destroyed) res.writeHead(upstream >= 400 && upstream < 500 ? upstream : 502, cors);
        res.end();
        if (code && stderr && !closed) console.error('[decoder]', redactText(stderr.trim().split('\n').slice(-3).join(' | ')));
      };
      proc.on('error', (e) => {
        console.error('[decoder] ffmpeg failed:', e?.code || e?.message);
        finish(-1);
      });
      proc.on('close', (code) => finish(code));
      proc.stderr?.on('data', (d) => {
        const text = String(d);
        const m = /out_time_us=(\d+)/.exec(text.match(/out_time_us=\d+/g)?.pop() ?? '');
        if (m) outTime = +m[1] / 1e6;
        // Keep -progress key=value lines out of the error log.
        const lines = text.split(/\r?\n/).filter((l) => l && !/^[a-z_0-9]+=/.test(l));
        if (!lines.length) return;
        stderr = (stderr + lines.join('\n') + '\n').slice(-4000);
        if (!started && upstream === null) {
          upstream = parseHttpStatus(stderr);
          if (upstream && proc.exitCode === null) proc.kill('SIGKILL'); // report it now instead of after retries
        }
      });
      // Send headers only once ffmpeg produces output, so failures can still return an error status.
      proc.stdout?.on('data', (chunk) => {
        if (res.destroyed) return;
        if (!started) {
          started = true;
          firstAt = Date.now();
          res.writeHead(200, { ...cors, 'Content-Type': 'video/mp2t' });
        }
        if (!res.write(chunk)) {
          draining = true;
          proc.stdout.pause();
          res.once('drain', () => { draining = false; flow(); });
        }
      });
      if (opts.lead && info?.duration) {
        pacer = setInterval(() => {
          if (!started) return;
          const allowed = (Date.now() - firstAt) / 1000 + opts.lead;
          if (!gated && outTime > allowed) { gated = true; proc.stdout.pause(); }
          else if (gated && outTime <= allowed - 1) { gated = false; flow(); }
        }, 250);
      }
    };
    launch(0, opts.hw && !!hwEncoder && !hwBroken);
    if (closed) onClose();
  });
  server.listen(0, '127.0.0.1', () => { port = server.address().port; });

  // Renderer probes are rare (only after a silent failure) but still capped so they can't pile up connections.
  let probing = 0;
  const waiters = [];
  const acquire = () => (probing < MAX_PROBES ? (probing++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
  const releaseProbe = () => { const next = waiters.shift(); if (next) next(); else probing--; };

  ipcMain.handle('dial:decoder-info', () => ({ available, hwEncoder: hwBroken ? null : hwEncoder, hwChecked }));
  ipcMain.handle('dial:probe', async (_e, raw, headers) => {
    const src = normalizeSource(raw);
    if (!available || !src) return null;
    const hit = cached(src);
    if (hit !== undefined) return hit;
    if (inflight.has(src)) return (await inflight.get(src)).info;
    if (waiters.length > 8) return null;
    await acquire();
    try {
      const r = await runProbe(src, headers && typeof headers === 'object' ? headers : {});
      return r.info ?? (r.status ? { video: null, audio: null, interlaced: false, resolution: null, httpStatus: r.status } : null);
    } finally {
      releaseProbe();
    }
  });
  // What the decoder server's own probe found for this URL (no new connection).
  ipcMain.handle('dial:decoder-info-for', async (_e, raw) => {
    const src = normalizeSource(raw);
    if (!src) return null;
    const hit = cached(src);
    if (hit !== undefined) return hit;
    return inflight.has(src) ? (await inflight.get(src)).info : null;
  });
  ipcMain.handle('dial:decoder-url', (_e, raw, headers, opts) => {
    const src = normalizeSource(raw);
    if (!available || !port || !src) return null;
    const q = new URLSearchParams({
      t: TOKEN, u: String(raw).trim(), h: JSON.stringify(headers && typeof headers === 'object' ? headers : {}),
      o: JSON.stringify(sanitizeOptions(opts)), // validated here and again when the stream is opened
    });
    return `http://127.0.0.1:${port}/stream?${q}`;
  });

  app.on('before-quit', () => { for (const s of sessions) s.kill('SIGKILL'); server.close(); });
}

module.exports = {
  start, probe, ffmpegPath, transcodeArgs, inputArgs, sanitizeOptions, videoEncoderArgs, detectHwEncoder, rateFor, DEFAULT_OPTS, HW_CANDIDATES, parseProbe, parseHttpStatus, needsVideoTranscode,
  normalizeSource, splitHeaders, cleanHeader, redactUrl, redactText, PROTOCOL_WHITELIST, VLC_UA,
};

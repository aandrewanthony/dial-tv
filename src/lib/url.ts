// URL validation and credential redaction for untrusted playlist/EPG input.

const STREAM_PROTOCOLS = new Set(['http:', 'https:']);
/** Everything VLC plays from a playlist line. Non-http(s) links only ever go to the built-in decoder (ffmpeg). */
const MEDIA_PROTOCOLS = new Set(['http:', 'https:', 'rtmp:', 'rtmps:', 'rtsp:', 'rtsps:', 'rtp:', 'udp:', 'mms:', 'mmsh:', 'mmst:', 'srt:']);

/** Returns a normalized URL string if it is an allowed http(s) URL, else null. */
export function safeUrl(raw: string | undefined | null, base?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed, base);
    if (!STREAM_PROTOCOLS.has(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Stream URLs from a playlist: http(s) plus the streaming protocols VLC accepts
 * (rtmp, rtsp, rtp, udp, mms, srt, ...). Non-http URLs are returned as written so
 * forms like udp://@239.1.1.1:1234 survive. javascript:, file:, data:, etc. are rejected.
 */
export function safeStreamUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t || /[\s\0]/.test(t)) return null;
  try {
    const u = new URL(t);
    if (!MEDIA_PROTOCOLS.has(u.protocol)) return null;
    if (STREAM_PROTOCOLS.has(u.protocol)) return u.toString();
    if (!/^[a-z]+:\/\/./i.test(t)) return null; // needs an authority (host or @host)
    return t;
  } catch {
    return null;
  }
}

export const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);

/**
 * fetch()/XHR reject URLs with user:pass@. Split them into a clean URL plus a
 * Basic Authorization header (sent by the desktop shell's header map).
 */
export function splitUserinfo(raw: string): { url: string; authorization?: string } {
  try {
    const u = new URL(raw);
    if (!isHttpUrl(raw) || (!u.username && !u.password)) return { url: raw };
    const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
    const bytes = new TextEncoder().encode(`${dec(u.username)}:${dec(u.password)}`);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    u.username = '';
    u.password = '';
    return { url: u.toString(), authorization: `Basic ${btoa(bin)}` };
  } catch {
    return { url: raw };
  }
}

/** Image URLs additionally allow data:image for embedded logos. */
export function safeImageUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(t)) return t;
  return safeUrl(t) ?? undefined;
}

const SECRET_PARAMS = /^(user(name)?|pass(word)?|token|key|api_?key|auth|sig(nature)?|secret|session)$/i;

/** Strip user:pass@, secret query params, and Xtream-style /user/pass/ path segments for display & logs. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_PARAMS.test(k)) u.searchParams.set(k, '***');
    }
    // Xtream Codes: /live/<user>/<pass>/<id>.m3u8
    u.pathname = u.pathname.replace(/^\/(live|movie|series)\/[^/]+\/[^/]+\//, '/$1/***/***/');
    return u.toString().replace('***:@', '***@');
  } catch {
    return '[invalid url]';
  }
}

/** Header values from playlists are untrusted: no CR/LF/NUL (header injection), bounded length. */
export function cleanHeaderValue(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 4096) : '';
}

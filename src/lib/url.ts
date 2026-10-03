// URL validation and credential redaction for untrusted playlist/EPG input.

const STREAM_PROTOCOLS = new Set(['http:', 'https:']);

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

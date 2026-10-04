// Private ESPN fantasy leagues: the user's espn_s2 / SWID cookies (stored encrypted as secrets)
// are added by the shell to Dial TV's own requests to ESPN Fantasy hosts only. The renderer can
// save or remove them but never read them back (see WRITE_ONLY in main.cjs).

/** Secret names (lib/secrets.ts) holding the cookies. */
const ESPN_S2 = 'espn_s2';
const ESPN_SWID = 'espn_swid';

/** Exact hosts that receive the cookies (https only). */
const ESPN_FANTASY_HOSTS = new Set(['lm-api-reads.fantasy.espn.com', 'fantasy.espn.com']);

function isEspnFantasyUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ESPN_FANTASY_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** espn_s2 as pasted (maybe with "espn_s2=" or quotes) → the bare cookie value, or null if it isn't one. */
function cleanEspnS2(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/^espn_s2\s*=\s*/i, '').replace(/^"(.*)"$/, '$1').trim();
  return /^[A-Za-z0-9%+/=._~-]{20,2048}$/.test(v) ? v : null;
}

/** SWID as pasted ({GUID}, GUID, "SWID=…") → "{GUID}" uppercase, or null. */
function cleanSwid(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/^swid\s*=\s*/i, '').replace(/^"(.*)"$/, '$1').trim().replace(/^\{|\}$/g, '');
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(v) ? `{${v.toUpperCase()}}` : null;
}

/** Cookie header value for both cookies, or null unless both are valid. */
function espnCookieHeader(s2, swid) {
  const a = cleanEspnS2(s2);
  const b = cleanSwid(swid);
  return a && b ? `espn_s2=${a}; SWID=${b}` : null;
}

/** A Cookie header value without espn_s2 / SWID ('' if nothing else is left). */
function stripEspnCookies(existing) {
  return String(existing || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !/^(espn_s2|swid)=/i.test(s))
    .join('; ');
}

/** Merge ESPN's cookies into an existing Cookie header value (ours replace any same-named ones). */
function mergeCookie(existing, header) {
  return [stripEspnCookies(existing), header].filter(Boolean).join('; ');
}

module.exports = { ESPN_S2, ESPN_SWID, ESPN_FANTASY_HOSTS, isEspnFantasyUrl, cleanEspnS2, cleanSwid, espnCookieHeader, stripEspnCookies, mergeCookie };

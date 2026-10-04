/**
 * Xtream Codes login (player_api.php) as a playlist source: the user's own provider account,
 * mapped onto the same Channel model as an M3U playlist so channel organization, guide,
 * favorites and Movies & Series work unchanged.
 *
 *   player_api.php?username&password                       → user_info (account) + server_info
 *   …&action=get_live_categories / get_live_streams         → live channels
 *   …&action=get_vod_categories / get_vod_streams           → movies (series need one request per show: not loaded)
 *   xmltv.php?username&password                             → guide (added as the playlist's guide source)
 *   stream: {server}/live/{user}/{pass}/{stream_id}.{ts|m3u8}, movies: /movie/{user}/{pass}/{id}.{ext}
 */
import type { Channel, PlaylistSource, XtreamAccount, XtreamLogin } from '../types';
import type { PlaylistProvider } from './types';
import { classifyContent } from '../lib/content';
import { safeImageUrl, safeUrl } from '../lib/url';
import { fetchText } from '../lib/net';
import { markFor } from '../lib/m3u';

/** What the login form accepts in the server field: a server, or a whole get.php / player_api.php link. */
export interface XtreamInput {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Normalize a server address: adds http:// when missing, drops the path to player_api.php / get.php /
 * xmltv.php and trailing slashes, and picks up username/password from a pasted get.php link.
 * Returns null for anything that is not http(s).
 */
export function parseXtreamServer(raw: string): XtreamInput | null {
  let t = raw.trim();
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `http://${t}`;
  const ok = safeUrl(t);
  if (!ok) return null;
  const u = new URL(ok);
  const username = u.searchParams.get('username') ?? undefined;
  const password = u.searchParams.get('password') ?? undefined;
  let path = u.pathname.replace(/\/(player_api|get|xmltv|panel_api)\.php$/i, '/').replace(/\/+$/, '');
  if (path === '/') path = '';
  return {
    server: `${u.protocol}//${u.host}${path}`,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

const enc = encodeURIComponent;

export function xtreamApiUrl(l: Pick<XtreamLogin, 'server' | 'username' | 'password'>, action?: string): string {
  return `${l.server}/player_api.php?username=${enc(l.username)}&password=${enc(l.password)}${action ? `&action=${action}` : ''}`;
}

export function xtreamXmltvUrl(l: Pick<XtreamLogin, 'server' | 'username' | 'password'>): string {
  return `${l.server}/xmltv.php?username=${enc(l.username)}&password=${enc(l.password)}`;
}

export function xtreamStreamUrl(
  l: Pick<XtreamLogin, 'server' | 'username' | 'password'>,
  type: 'live' | 'movie' | 'series',
  id: string | number,
  ext: string,
): string {
  return `${l.server}/${type}/${enc(l.username)}/${enc(l.password)}/${enc(String(id))}.${ext}`;
}

// ---------- JSON shapes (providers vary: numbers arrive as strings and the other way round) ----------

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === 'object') : []);

/** user_info → account. `exp_date` is epoch seconds (null / "0" / missing = no expiry). */
export function parseAccount(userInfo: unknown): XtreamAccount {
  const u = (userInfo && typeof userInfo === 'object' ? userInfo : {}) as Json;
  const exp = num(u.exp_date);
  const max = num(u.max_connections);
  const active = num(u.active_cons);
  const formats = Array.isArray(u.allowed_output_formats) ? u.allowed_output_formats.filter((f): f is string => typeof f === 'string') : undefined;
  const trial = str(u.is_trial);
  return {
    ...(str(u.status) ? { status: str(u.status) } : {}),
    ...(exp && exp > 0 ? { expiresAt: exp * 1000 } : {}),
    ...(max != null && max >= 0 ? { maxConnections: max } : {}),
    ...(active != null && active >= 0 ? { activeConnections: active } : {}),
    ...(trial != null ? { isTrial: trial === '1' || trial === 'true' } : {}),
    ...(formats?.length ? { formats } : {}),
  };
}

/** Live container for this login: an explicit choice, else ts unless the account only allows HLS. */
export function liveExtension(output: XtreamLogin['output'], account?: XtreamAccount): 'ts' | 'm3u8' {
  if (output === 'ts' || output === 'm3u8') return output;
  const f = account?.formats;
  if (f?.length && !f.includes('ts') && f.includes('m3u8')) return 'm3u8';
  return 'ts';
}

export interface XtreamData {
  liveCategories?: unknown;
  live?: unknown;
  vodCategories?: unknown;
  vod?: unknown;
}

const categoryNames = (cats: unknown) => new Map(arr(cats).map((c) => [str(c.category_id) ?? '', (str(c.category_name) ?? '').trim()]));

/**
 * Map player_api.php lists to channels, the same shape parseM3U produces:
 * id `${sourceId}:${epg_channel_id || name}` (lower case, duplicates get #n), numbers from numberStart
 * in provider order, group = category name, tvgId = epg_channel_id. Movies get kind 'movie' (+ title/year).
 */
export function mapXtream(sourceId: string, login: Pick<XtreamLogin, 'server' | 'username' | 'password'>, data: XtreamData, numberStart: number, liveExt: 'ts' | 'm3u8' = 'ts'): Channel[] {
  const out: Channel[] = [];
  const seen = new Set<string>();
  const add = (c: Omit<Channel, 'id' | 'number' | 'sourceId' | 'mark'>, key: string) => {
    let id = `${sourceId}:${key}`.toLowerCase();
    if (seen.has(id)) id = `${id}#${out.length}`;
    seen.add(id);
    out.push({ id, number: numberStart + out.length, sourceId, mark: markFor(c.name), ...c });
  };

  const liveCats = categoryNames(data.liveCategories);
  const live = arr(data.live).slice().sort((a, b) => (num(a.num) ?? Infinity) - (num(b.num) ?? Infinity));
  for (const s of live) {
    const sid = str(s.stream_id);
    if (!sid) continue;
    const name = (str(s.name)?.trim() || `Channel ${out.length + 1}`).slice(0, 120);
    const tvgId = str(s.epg_channel_id)?.trim() || undefined;
    add({
      name,
      group: (liveCats.get(str(s.category_id) ?? '') || 'Uncategorized').slice(0, 60),
      logo: safeImageUrl(str(s.stream_icon)),
      url: xtreamStreamUrl(login, 'live', sid, liveExt),
      tvgId,
    }, tvgId || name);
  }

  const vodCats = categoryNames(data.vodCategories);
  for (const s of arr(data.vod)) {
    const sid = str(s.stream_id);
    if (!sid) continue;
    const name = (str(s.name)?.trim() || `Movie ${sid}`).slice(0, 120);
    const ext = (str(s.container_extension) ?? 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
    const group = (vodCats.get(str(s.category_id) ?? '') || 'Movies').slice(0, 60);
    const url = xtreamStreamUrl(login, 'movie', sid, ext);
    const info = classifyContent({ name, group, url, type: 'movie' });
    add({
      name,
      group,
      logo: safeImageUrl(str(s.stream_icon)),
      url,
      kind: 'movie',
      title: info.title,
      ...(info.year ? { year: info.year } : {}),
    }, `movie-${sid}`);
  }
  return out;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const text = await fetchText(url, signal);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The server did not answer like an Xtream Codes server (check the server address)');
  }
}

/** Log in: returns the account, or throws a readable error (wrong login, expired, banned...). */
export async function xtreamLogin(login: XtreamLogin, signal?: AbortSignal): Promise<XtreamAccount> {
  const j = (await getJson(xtreamApiUrl(login), signal)) as Json | null;
  const ui = j && typeof j === 'object' ? (j.user_info as Json | undefined) : undefined;
  if (!ui || num(ui.auth) === 0) throw new Error('Login failed: check the username and password');
  const account = parseAccount(ui);
  const st = account.status?.toLowerCase();
  if (st && st !== 'active') throw new Error(`Account ${account.status}${account.expiresAt ? ` (expired ${new Date(account.expiresAt).toLocaleDateString()})` : ''}`);
  return account;
}

export type XtreamLoadResult = Awaited<ReturnType<PlaylistProvider['load']>> & { account: XtreamAccount };

export function xtreamProvider(src: PlaylistSource, numberStart: number): { id: string; load(signal?: AbortSignal): Promise<XtreamLoadResult> } {
  return {
    id: src.id,
    async load(signal) {
      const login = src.xtream;
      if (!login?.server || !login.username || !login.password) throw new Error('Xtream login is missing — remove this playlist and add it again');
      const account = await xtreamLogin(login, signal);
      const [liveCategories, live] = await Promise.all([
        getJson(xtreamApiUrl(login, 'get_live_categories'), signal).catch(() => []),
        getJson(xtreamApiUrl(login, 'get_live_streams'), signal),
      ]);
      // Movies are optional: a provider without VOD (or a slow VOD list) must not break live TV.
      const [vodCategories, vod] = await Promise.all([
        getJson(xtreamApiUrl(login, 'get_vod_categories'), signal).catch(() => []),
        getJson(xtreamApiUrl(login, 'get_vod_streams'), signal).catch(() => []),
      ]);
      const channels = mapXtream(src.id, login, { liveCategories, live, vodCategories, vod }, numberStart, liveExtension(login.output, account));
      return { channels, epgUrl: xtreamXmltvUrl(login), skipped: 0, account };
    },
  };
}

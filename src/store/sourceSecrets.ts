/**
 * Playlist / guide logins kept out of plain IndexedDB on desktop.
 *
 * Playlist links often embed the provider login (get.php?username=…&password=…, user:pass@,
 * tokens), and an Xtream Codes password is a credential. In memory the app keeps the real values
 * (every loader reads `src.url` / `src.xtream.password` as before). When the state is SAVED on
 * desktop, those values go to the OS keychain (lib/secrets.ts → Electron safeStorage) and the
 * IndexedDB copy only carries `keychain: true`. Loading puts them back.
 *
 * Web: unchanged (saved in IndexedDB as before) — the browser has no keychain.
 *
 * Lossless by construction: a value is removed from the IndexedDB copy only after the keychain
 * write succeeded; if it fails, the record is saved as before. If the keychain cannot be read
 * later, the record keeps its marker (so the next save doesn't drop the stored login) and shows an error.
 */
import type { Channel, EpgSource, PlaylistSource } from '../types';
import type { PersistedState } from './app';
import { getSecret, secretsAreEncrypted, setSecret } from '../lib/secrets';

type Source = PlaylistSource | EpgSource;

/** What is secret about one source. */
export interface SourceSecret {
  url?: string;
  password?: string;
}

export const KEYCHAIN_READ_ERROR = 'Saved login could not be read from this computer’s keychain. Remove this source and add it again.';
export const NOT_IN_BACKUP_ERROR = 'The backup did not include this login. Remove this source and add it again.';
export const MISSING_LOGIN_ERROR = 'This playlist’s link or login is missing (backups leave it out unless you include it). Remove it and add it again.';

/** Keychain entry name for a source id (the shell allows [a-z0-9_-]{1,40}). */
export function secretNameFor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  const slug = id.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 24);
  return `src-${slug}-${(h >>> 0).toString(36)}`;
}

/** The secret part of a source, or null when it has none (local files, incomplete records). */
export function secretOf(x: Source): SourceSecret | null {
  if ((x.kind === 'm3u-url' || x.kind === 'xmltv-url') && x.url) return { url: x.url };
  if (x.kind === 'xtream' && (x as PlaylistSource).xtream?.password) return { password: (x as PlaylistSource).xtream!.password };
  return null;
}

/** The source without its secret (for the IndexedDB copy or an export). */
export function withoutSecret<T extends Source>(x: T): T {
  const out = { ...x } as T & { url?: string; xtream?: PlaylistSource['xtream'] };
  if (out.kind === 'm3u-url' || out.kind === 'xmltv-url') delete out.url;
  if (out.kind === 'xtream' && out.xtream) {
    const { password: _p, ...rest } = out.xtream;
    out.xtream = rest as PlaylistSource['xtream'];
  }
  return out;
}

export function withSecret<T extends Source>(x: T, s: SourceSecret): T {
  const out = { ...x } as T & { url?: string; xtream?: PlaylistSource['xtream']; keychain?: boolean };
  delete out.keychain;
  if (s.url && (out.kind === 'm3u-url' || out.kind === 'xmltv-url')) out.url = s.url;
  if (s.password && out.kind === 'xtream' && out.xtream) out.xtream = { ...out.xtream, password: s.password };
  return out;
}

/** Keychain entries written or read by this session: name → JSON value. */
const known = new Map<string, string>();

/** Test hook. */
export function resetSourceSecrets() {
  known.clear();
}

/** True when the state still holds a login in plain form that should move to the keychain. */
export function needsSeal(s: Pick<PersistedState, 'playlists' | 'epgSources'>): boolean {
  return secretsAreEncrypted() && [...s.playlists, ...s.epgSources].some((x) => !x.keychain && !!secretOf(x));
}

/**
 * Desktop: write changed logins to the keychain and return the copy to save in IndexedDB (no logins).
 * Keychain entries of sources that were removed are deleted. Web: returns the state unchanged.
 */
export async function sealPersisted(state: PersistedState): Promise<PersistedState> {
  if (!secretsAreEncrypted()) return state;
  const live = new Set<string>();
  const seal = async <T extends Source>(x: T): Promise<T> => {
    const name = secretNameFor(x.id);
    if (x.keychain) {
      // Login stored but not readable this session: keep the entry and the marker untouched.
      live.add(name);
      return x;
    }
    const sec = secretOf(x);
    if (!sec) return x;
    const value = JSON.stringify(sec);
    if (value.length > 4000) return x; // too long for the keychain store: keep as before
    if (known.get(name) !== value) {
      const ok = await setSecret(name, value).catch(() => false);
      if (!ok) return x; // keychain unavailable: save as before (never lose the login)
      known.set(name, value);
    }
    live.add(name);
    return { ...withoutSecret(x), keychain: true };
  };
  const playlists = await Promise.all(state.playlists.map(seal));
  const epgSources = await Promise.all(state.epgSources.map(seal));
  for (const name of [...known.keys()]) {
    if (live.has(name)) continue;
    known.delete(name);
    void setSecret(name, null).catch(() => undefined);
  }
  return { ...state, playlists, epgSources };
}

/** Put saved logins back into a state read from IndexedDB. Unreadable ones keep their marker + an error. */
export async function openPersisted<S extends Pick<PersistedState, 'playlists' | 'epgSources'>>(state: S): Promise<S> {
  const open = async <T extends Source>(x: T): Promise<T> => {
    if (!x.keychain) return x;
    const name = secretNameFor(x.id);
    const raw = await getSecret(name).catch(() => null);
    let sec: SourceSecret | null = null;
    try {
      sec = raw ? (JSON.parse(raw) as SourceSecret) : null;
    } catch {
      sec = null;
    }
    if (!sec || (!sec.url && !sec.password)) return { ...x, error: KEYCHAIN_READ_ERROR };
    known.set(name, raw!);
    return withSecret(x, sec);
  };
  const playlists = Array.isArray(state.playlists) ? await Promise.all(state.playlists.map(open)) : state.playlists;
  const epgSources = Array.isArray(state.epgSources) ? await Promise.all(state.epgSources.map(open)) : state.epgSources;
  return { ...state, playlists, epgSources };
}

// ---------- export / import ----------

/** Settings export: drops playlist links, Xtream passwords and guide links unless the user asks to include them. */
export function exportablePersisted(state: PersistedState, includeLogins: boolean): PersistedState {
  const clean = <T extends Source>(x: T): T => {
    const { keychain: _k, ...rest } = x;
    return (includeLogins ? rest : withoutSecret(rest as T)) as T;
  };
  return { ...state, playlists: state.playlists.map(clean), epgSources: state.epgSources.map(clean) };
}

const lacksSecret = (x: Source) => (x.kind === 'm3u-url' || x.kind === 'xmltv-url' || x.kind === 'xtream') && !secretOf(x);

/**
 * Settings import: a source exported without its login keeps the login this device already has
 * for the same source id; otherwise it shows an error asking to add it again.
 */
export function mergeImportedSecrets(imported: PersistedState, current: Pick<PersistedState, 'playlists' | 'epgSources'>): PersistedState {
  const fix = <T extends Source>(x: T, have: Source[]): T => {
    const { keychain: _k, ...rest } = x;
    const y = rest as T;
    if (!lacksSecret(y)) return y;
    const mine = have.find((h) => h.id === y.id && h.kind === y.kind);
    const sec = mine && secretOf(mine);
    if (sec) return withSecret(y, sec);
    return { ...y, error: NOT_IN_BACKUP_ERROR };
  };
  return {
    ...imported,
    playlists: imported.playlists.map((p) => fix(p, current.playlists)),
    epgSources: imported.epgSources.map((e) => fix(e, current.epgSources)),
  };
}

// ---------- cached channels ----------

const TOKEN = (i: number) => `\u0001${i}\u0001`;

/** Login strings that appear inside a source's stream URLs (raw and URL-encoded), longest first. */
export function secretStrings(src: PlaylistSource): string[] {
  const vals: string[] = [];
  if (src.kind === 'xtream' && src.xtream) vals.push(src.xtream.password, src.xtream.username);
  else if (src.kind === 'm3u-url' && src.url) {
    try {
      const u = new URL(src.url);
      vals.push(decodeURIComponent(u.password), decodeURIComponent(u.username));
      for (const [k, v] of u.searchParams) if (/^(user(name)?|pass(word)?|pwd|token|key|api_?key|auth|secret)$/i.test(k)) vals.push(v);
    } catch {
      /* ignore */
    }
  }
  const out = new Set<string>();
  for (const v of vals) {
    if (!v || v.length < 3 || v.includes('\u0001')) continue;
    out.add(v);
    out.add(encodeURIComponent(v));
  }
  return [...out].sort((a, b) => b.length - a.length).slice(0, 9);
}

/**
 * The channel cache holds every stream URL, and Xtream stream URLs carry the login in their path.
 * On desktop the cached copy has those strings replaced by placeholders; openChannels puts them back.
 */
export function sealChannels(channels: Channel[], playlists: PlaylistSource[]): Channel[] {
  if (!secretsAreEncrypted()) return channels;
  const bySource = new Map(playlists.map((p) => [p.id, secretStrings(p)]));
  const swap = (u: string, vals: string[]) => vals.reduce((acc, v, i) => acc.split(v).join(TOKEN(i)), u);
  return channels.map((c) => {
    const vals = bySource.get(c.sourceId);
    if (!vals?.length) return c;
    const url = swap(c.url, vals);
    const fallbackUrls = c.fallbackUrls?.map((f) => swap(f, vals));
    return url === c.url && !fallbackUrls?.some((f, i) => f !== c.fallbackUrls![i]) ? c : { ...c, url, ...(fallbackUrls ? { fallbackUrls } : {}) };
  });
}

/** Reverse of sealChannels. Channels whose login is not available are dropped (they could not play). */
export function openChannels(channels: Channel[], playlists: PlaylistSource[]): Channel[] {
  const bySource = new Map(playlists.map((p) => [p.id, secretStrings(p)]));
  const unswap = (u: string, vals: string[]) => {
    let out = u;
    for (let i = vals.length - 1; i >= 0; i--) out = out.split(TOKEN(i)).join(vals[i]);
    return out;
  };
  const out: Channel[] = [];
  for (const c of channels) {
    if (!c.url.includes('\u0001') && !c.fallbackUrls?.some((f) => f.includes('\u0001'))) {
      out.push(c);
      continue;
    }
    const vals = bySource.get(c.sourceId) ?? [];
    const url = unswap(c.url, vals);
    if (url.includes('\u0001')) continue;
    const fallbackUrls = c.fallbackUrls?.map((f) => unswap(f, vals)).filter((f) => !f.includes('\u0001'));
    out.push({ ...c, url, ...(fallbackUrls ? { fallbackUrls } : {}) });
  }
  return out;
}

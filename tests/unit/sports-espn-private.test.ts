import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  cleanEspnS2, cleanSwid, clearEspnCookies, EspnFantasyError, espnSnapshot, fetchEspnLeague, hasEspnCookies, leagueUrl, saveEspnCookies,
} from '../../src/providers/espnFantasy';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shell = require('../../electron/espnAuth.cjs');

const ff = readFileSync(resolve('tests/fixtures/espn-ff.json'), 'utf8');
const unauthorized = readFileSync(resolve('tests/fixtures/espn-ff-unauthorized.json'), 'utf8');

const S2 = 'AEBx%2Bk9Qp7rZ1y0abcDEF%2Fghij%3D%3Dklmnop123456';
const SWID = '{1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d}';

type Call = { url: string; init?: RequestInit };
function fakeFetch(status: number, body: string, calls: Call[] = []) {
  const f = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { 'content-type': body.startsWith('<') ? 'text/html' : 'application/json' } });
  };
  return f as typeof fetch;
}

/** A desktop bridge with an in-memory keychain (write-only names, like the shell). */
function installDesktop() {
  const store = new Map<string, string>();
  (window as unknown as { dialDesktop?: unknown }).dialDesktop = {
    platform: 'win32',
    setMiniPlayer: async () => false,
    version: async () => 'test',
    secrets: {
      get: async (n: string) => (n === 'espn_s2' || n === 'espn_swid' ? null : store.get(n) ?? null),
      set: async (n: string, v: string | null) => { if (v) store.set(n, v); else store.delete(n); return true; },
      has: async (n: string) => store.has(n),
    },
  };
  return store;
}

afterEach(() => {
  delete (window as unknown as { dialDesktop?: unknown }).dialDesktop;
  localStorage.clear();
});

describe('ESPN private leagues: request + parse', () => {
  it('fetches the league URL with the views the parser needs and parses the fixture', async () => {
    const calls: Call[] = [];
    const snap = await espnSnapshot('424242', '2026', '1', { fetch: fakeFetch(200, ff, calls) });
    expect(calls[0].url).toBe(leagueUrl('424242', '2026'));
    expect(calls[0].url).toMatch(/^https:\/\/lm-api-reads\.fantasy\.espn\.com\/apis\/v3\/games\/ffl\/seasons\/2026\/segments\/0\/leagues\/424242\?/);
    for (const v of ['mMatchupScore', 'mTeam', 'mRoster', 'mSettings']) expect(calls[0].url).toContain(`view=${v}`);
    // The renderer never sends cookies or credentials itself; the desktop shell adds them.
    expect(calls[0].init?.credentials).toBeUndefined();
    expect(JSON.stringify(calls[0].init?.headers ?? {})).not.toMatch(/cookie/i);
    expect(snap.league.name).toBe('Sunday Funday League');
    expect(snap.matchup?.me.teamName).toBe('Gridiron Gurus');
  });

  it('private league fetched with saved cookies parses the same way (desktop)', async () => {
    installDesktop();
    const snap = await espnSnapshot('424242', '2026', '1', { private: true, fetch: fakeFetch(200, ff) });
    expect(snap.matchup?.opponent?.teamName).toBe('Bro Ballers');
  });

  it('public request to a private league (web): explains the desktop app requirement', async () => {
    const err = await fetchEspnLeague('424242', '2026', { fetch: fakeFetch(401, unauthorized) }).catch((e) => e);
    expect(err).toBeInstanceOf(EspnFantasyError);
    expect(err.code).toBe('private');
    expect(err.message).toMatch(/desktop app/);
    expect(err.message).toMatch(/Viewable to Public/);
  });

  it('public request to a private league (desktop): points at the Private league option', async () => {
    installDesktop();
    const err = await fetchEspnLeague('424242', '2026', { fetch: fakeFetch(401, unauthorized) }).catch((e) => e);
    expect(err.code).toBe('private');
    expect(err.message).toMatch(/Private league/);
  });

  it('expired / invalid cookies → friendly auth error (401, 403, HTML sign-in page, error body)', async () => {
    installDesktop();
    for (const [status, body] of [[401, unauthorized], [403, ''], [200, '<!doctype html><title>Log In</title>'], [200, unauthorized]] as const) {
      const err = await fetchEspnLeague('424242', '2026', { private: true, fetch: fakeFetch(status, body) }).catch((e) => e);
      expect(err, `${status} ${body.slice(0, 20)}`).toBeInstanceOf(EspnFantasyError);
      expect(err.code).toBe('auth');
      expect(err.message).toMatch(/expired/);
      expect(err.message).not.toMatch(/password/i);
    }
  });

  it('private league on the web refuses before any request', async () => {
    const calls: Call[] = [];
    const err = await fetchEspnLeague('424242', '2026', { private: true, fetch: fakeFetch(200, ff, calls) }).catch((e) => e);
    expect(err.code).toBe('private');
    expect(calls).toHaveLength(0);
  });

  it('404 and other errors keep their messages', async () => {
    expect((await fetchEspnLeague('1', '2026', { fetch: fakeFetch(404, '{}') }).catch((e) => e)).code).toBe('notfound');
    expect((await fetchEspnLeague('1', '2026', { fetch: fakeFetch(500, '') }).catch((e) => e)).message).toMatch(/500/);
    expect((await fetchEspnLeague('abc', '2026', { fetch: fakeFetch(200, ff) }).catch((e) => e)).status).toBe(400);
  });
});

describe('ESPN cookies: validation and storage', () => {
  it('cleans pasted values the same way as the desktop shell', () => {
    for (const raw of [S2, ` espn_s2=${S2} `, `"${S2}"`, 'short', 'has space in it but is long enough', `${S2};x=1`, '']) {
      expect(cleanEspnS2(raw)).toBe(shell.cleanEspnS2(raw));
    }
    for (const raw of [SWID, SWID.slice(1, -1), `SWID=${SWID}`, `"${SWID}"`, '{not-a-guid}', '']) {
      expect(cleanSwid(raw)).toBe(shell.cleanSwid(raw));
    }
    expect(cleanEspnS2(`espn_s2=${S2}`)).toBe(S2);
    expect(cleanSwid(SWID.slice(1, -1))).toBe(SWID.toUpperCase());
    expect(cleanEspnS2(`${S2}\r\nX-Evil: 1`)).toBeNull();
  });

  it('web: refuses to save, and never writes the cookies to localStorage', async () => {
    expect(await saveEspnCookies(S2, SWID)).toMatch(/desktop app/);
    expect(await hasEspnCookies()).toBe(false);
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it('desktop: validates, saves cleaned values to the keychain and can remove them', async () => {
    const store = installDesktop();
    expect(await saveEspnCookies('nope', SWID)).toMatch(/espn_s2/);
    expect(await saveEspnCookies(S2, 'nope')).toMatch(/SWID/);
    expect(store.size).toBe(0);
    expect(await saveEspnCookies(`espn_s2=${S2}`, SWID.slice(1, -1))).toBeUndefined();
    expect(store.get('espn_s2')).toBe(S2);
    expect(store.get('espn_swid')).toBe(SWID.toUpperCase());
    expect(await hasEspnCookies()).toBe(true);
    await clearEspnCookies();
    expect(await hasEspnCookies()).toBe(false);
  });
});

describe('desktop shell: cookie injection rules', () => {
  it('only ESPN Fantasy hosts over https get the cookies', () => {
    expect(shell.isEspnFantasyUrl(leagueUrl('1', '2026'))).toBe(true);
    expect(shell.isEspnFantasyUrl('https://fantasy.espn.com/apis/v3/games/ffl/seasons/2026')).toBe(true);
    for (const u of [
      'http://lm-api-reads.fantasy.espn.com/x', 'https://site.api.espn.com/apis/site/v2/sports', 'https://www.espn.com/',
      'https://lm-api-reads.fantasy.espn.com.evil.example/x', 'https://evil.example/?u=https://fantasy.espn.com', 'https://user:pw@fantasy.espn.com/', 'not a url',
    ]) expect(shell.isEspnFantasyUrl(u), u).toBe(false);
  });

  it('builds the Cookie header only from two valid values and merges with existing cookies', () => {
    const h = shell.espnCookieHeader(S2, SWID.slice(1, -1));
    expect(h).toBe(`espn_s2=${S2}; SWID=${SWID.toUpperCase()}`);
    expect(shell.espnCookieHeader(S2, null)).toBeNull();
    expect(shell.espnCookieHeader('bad', SWID)).toBeNull();
    expect(shell.mergeCookie('', h)).toBe(h);
    expect(shell.mergeCookie('a=1; espn_s2=old; SWID={OLD}', h)).toBe(`a=1; ${h}`);
    expect(shell.stripEspnCookies(`a=1; ${h}`)).toBe('a=1');
    expect(shell.stripEspnCookies(h)).toBe('');
  });
});

// Dial TV desktop shell (Electron). Loads the built web app from dist/ and gives it
// what a browser can't: access to IPTV hosts that don't send CORS headers.
const { app, BrowserWindow, ipcMain, session, shell, Menu, safeStorage, dialog, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const decoder = require('./decoder.cjs');
const installer = require('./installer.cjs');
const dvr = require('./dvr.cjs');
const timeshift = require('./timeshift.cjs');
const espnAuth = require('./espnAuth.cjs');
const remote = require('./remoteMain.cjs');
const { cleanHeader, VLC_UA } = decoder;

const isDev = !app.isPackaged && process.env.DIAL_DEV_URL;

// Separate profile (data + single-instance lock) for testing next to an installed copy.
if (process.env.DIAL_PROFILE) app.setPath('userData', path.join(app.getPath('temp'), 'dial-tv-' + process.env.DIAL_PROFILE));
let win;
const appContents = new Set(); // webContents ids of Dial TV's own windows
const APP_INDEX = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;

/**
 * Per-stream request headers (playlist User-Agent / Referer / Origin / Cookie, Basic auth),
 * registered by the player before it connects. Applied here instead of as custom request
 * headers so hls.js/mpegts.js/<video> requests need no CORS preflight.
 */
const byUrl = new Map(); // exact URL → headers
const byOrigin = new Map(); // origin → headers (segments, keys, redirects on the same host)
const MAX_ENTRIES = 256;
const remember = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
};
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
const isSecret = (name) => /^(authorization|cookie)$/i.test(name);

/** Validate + sanitize headers from the renderer (no CR/LF, no hop-by-hop headers). */
function sanitizeHeaders(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw).slice(0, 32)) {
    const val = cleanHeader(v);
    if (val && /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(k) && !/^(host|content-length|connection|transfer-encoding|upgrade|te|keep-alive|proxy-.*)$/i.test(k)) out[k] = val;
  }
  return out;
}

ipcMain.handle('dial:stream-headers', (e, url, headers) => {
  if (!appContents.has(e.sender.id) || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  const origin = originOf(url);
  if (!origin) return false;
  const h = sanitizeHeaders(headers);
  remember(byUrl, url, h);
  remember(byOrigin, origin, h);
  return true;
});

/** Set a header, replacing any existing spelling of the same name. */
function setHeader(h, name, value) {
  for (const k of Object.keys(h)) if (k.toLowerCase() === name.toLowerCase()) delete h[k];
  h[name] = value;
}
const getHeader = (h, name) => Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// Requests that belong to Dial TV: its windows, or workers it started (no webContents).
const fromApp = (d) => d.webContentsId === undefined || appContents.has(d.webContentsId);
const STREAM_TYPES = new Set(['xhr', 'media', 'other']);

/**
 * IPTV playlists, guides and streams almost never send CORS headers. For Dial TV's own
 * fetch/XHR/media requests we add permissive CORS response headers so fetch()/hls.js work
 * against any provider. Pages, scripts, images and other webContents are left alone.
 */
function allowCrossOrigin() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    if (!fromApp(details) || !STREAM_TYPES.has(details.resourceType)) return cb({ requestHeaders: h });
    // Private ESPN fantasy leagues: the user's espn_s2 / SWID, only on Dial TV's fetches to ESPN Fantasy hosts.
    if (details.resourceType === 'xhr' && espnAuth.isEspnFantasyUrl(details.url)) {
      const cookie = espnCookie();
      if (cookie) setHeader(h, 'Cookie', espnAuth.mergeCookie(getHeader(h, 'Cookie'), cookie));
      return cb({ requestHeaders: h });
    }
    // Never let them follow a redirect to another host.
    const cookieNow = getHeader(h, 'Cookie');
    if (cookieNow && espnCookieCache && cookieNow.includes(espnCookieCache)) {
      const rest = espnAuth.stripEspnCookies(cookieNow);
      if (rest) setHeader(h, 'Cookie', rest);
      else for (const k of Object.keys(h)) if (/^cookie$/i.test(k)) delete h[k];
    }
    const origin = originOf(details.url);
    const registered = byUrl.get(details.url) ?? (origin ? byOrigin.get(origin) : undefined);
    if (registered) {
      for (const [k, v] of Object.entries(registered)) setHeader(h, k, v);
      // VLC's User-Agent unless the playlist set one: some providers block browser UAs.
      if (!registered['User-Agent'] && !Object.keys(registered).some((k) => /^user-agent$/i.test(k))) setHeader(h, 'User-Agent', VLC_UA);
      const o = getHeader(h, 'Origin');
      if (!Object.keys(registered).some((k) => /^origin$/i.test(k)) && (o === 'null' || /^file:/i.test(o ?? ''))) {
        for (const k of Object.keys(h)) if (/^origin$/i.test(k)) delete h[k];
      }
    }
    cb({ requestHeaders: h });
  });
  // A stream that redirects to another host keeps its headers there (minus credentials).
  ses.webRequest.onBeforeRedirect((details) => {
    if (!fromApp(details) || !STREAM_TYPES.has(details.resourceType)) return;
    const from = byUrl.get(details.url) ?? byOrigin.get(originOf(details.url) ?? '');
    const to = originOf(details.redirectURL);
    if (!from || !to || byOrigin.has(to) || !/^https?:/i.test(to)) return;
    const safe = Object.fromEntries(Object.entries(from).filter(([k]) => !isSecret(k)));
    remember(byOrigin, to, safe);
  });
  ses.webRequest.onHeadersReceived((details, cb) => {
    if (!fromApp(details) || !STREAM_TYPES.has(details.resourceType) || !/^https?:/i.test(details.url)) return cb({});
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      if (!/^access-control-allow-(origin|headers|methods|credentials)$/i.test(k)) headers[k] = v;
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Headers'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, HEAD, OPTIONS'];
    headers['Access-Control-Expose-Headers'] = ['*'];
    // Some servers reject CORS preflights; answer them OK so GETs can proceed.
    if (details.method === 'OPTIONS') return cb({ responseHeaders: headers, statusLine: 'HTTP/1.1 200 OK' });
    cb({ responseHeaders: headers });
  });
}

/** Only the app itself may be loaded in the window (no dropped files, no redirects elsewhere). */
function isAppUrl(url) {
  if (isDev) return url.startsWith(process.env.DIAL_DEV_URL);
  const bare = String(url).split('#')[0];
  return process.platform === 'win32' || process.platform === 'darwin' ? bare.toLowerCase() === APP_INDEX.toLowerCase() : bare === APP_INDEX;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 380,
    minHeight: 260,
    backgroundColor: '#080a0f',
    title: 'Dial TV',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  const id = win.webContents.id;
  appContents.add(id);
  win.on('closed', () => {
    appContents.delete(id);
    win = null;
  });

  if (isDev) win.loadURL(process.env.DIAL_DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // External links open in the real browser; the app never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Also blocks a file dropped onto the window (Chromium navigates to it by default).
  win.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
  win.webContents.on('will-redirect', (e, url, _inPlace, isMainFrame) => { if (isMainFrame !== false && !isAppUrl(url)) e.preventDefault(); });
}

// Mini player: small, always-on-top window; restores the previous bounds when turned off.
let savedBounds;
ipcMain.handle('dial:mini-player', (_e, on) => {
  if (!win) return false;
  if (on) {
    savedBounds = win.getBounds();
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setBounds({ ...savedBounds, width: 560, height: 340 });
  } else {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
    if (savedBounds) win.setBounds(savedBounds);
  }
  return on;
});
ipcMain.handle('dial:version', () => app.getVersion());

// API keys (e.g. The Odds API) encrypted with the OS keychain (Windows DPAPI / macOS Keychain).
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
const readSecrets = () => { try { return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')); } catch { return {}; } };
const validName = (n) => typeof n === 'string' && /^[a-z0-9_-]{1,40}$/.test(n);
// Secrets only the shell uses: the renderer may save, remove or check them, never read them back.
const WRITE_ONLY = new Set([espnAuth.ESPN_S2, espnAuth.ESPN_SWID]);
const decryptSecret = (name) => {
  const enc = readSecrets()[name];
  if (!enc) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
};
ipcMain.handle('dial:secret-get', (e, name) => {
  if (!appContents.has(e.sender.id) || !validName(name) || WRITE_ONLY.has(name)) return null;
  return decryptSecret(name);
});
ipcMain.handle('dial:secret-has', (e, name) => {
  if (!appContents.has(e.sender.id) || !validName(name)) return false;
  return !!decryptSecret(name);
});

/** Cookie header for private ESPN leagues (decrypted once; cleared when either cookie changes). */
let espnCookieCache; // undefined = not read yet, null = not saved
function espnCookie() {
  if (espnCookieCache === undefined) espnCookieCache = espnAuth.espnCookieHeader(decryptSecret(espnAuth.ESPN_S2), decryptSecret(espnAuth.ESPN_SWID));
  return espnCookieCache;
}
ipcMain.handle('dial:secret-set', (e, name, value) => {
  if (!appContents.has(e.sender.id) || !validName(name)) return false;
  const all = readSecrets();
  if (value == null || value === '') delete all[name];
  else {
    if (!safeStorage.isEncryptionAvailable() || typeof value !== 'string' || value.length > 4096) return false;
    if (name === espnAuth.ESPN_S2 && !espnAuth.cleanEspnS2(value)) return false;
    if (name === espnAuth.ESPN_SWID && !espnAuth.cleanSwid(value)) return false;
    all[name] = safeStorage.encryptString(value).toString('base64');
  }
  fs.writeFileSync(secretsFile(), JSON.stringify(all), { mode: 0o600 });
  if (WRITE_ONLY.has(name)) espnCookieCache = undefined;
  return true;
});

// DVR (electron/dvr.cjs): records with the bundled ffmpeg; changes are pushed to the window.
function startDvr() {
  const rec = dvr.create({
    app, ipcMain, shell, safeStorage, dialog,
    ffmpegBin: decoder.ffmpegPath(app),
    inputArgs: decoder.inputArgs,
    redactText: decoder.redactText,
    isAppSender: (e) => appContents.has(e.sender.id),
    notify: (title, body) => { try { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show(); } catch { /* optional */ } },
  });
  rec.subscribe((snap) => { if (win && !win.isDestroyed()) win.webContents.send('dvr:changed', snap); });
}

// Pause & rewind live TV (electron/timeshift.cjs): one rolling ffmpeg HLS buffer at a time.
function startTimeshift() {
  timeshift.create({
    app, ipcMain,
    ffmpegBin: decoder.ffmpegPath(app),
    inputArgs: decoder.inputArgs,
    normalizeSource: decoder.normalizeSource,
    parseProbe: decoder.parseProbe,
    redactText: decoder.redactText,
    isAppSender: (e) => appContents.has(e.sender.id),
  });
}

// Single instance: a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  } else if (app.isReady() && gotLock) {
    createWindow();
  }
});
app.setAppUserModelId('com.dialtv.player'); // Windows notifications + taskbar grouping
app.whenReady().then(async () => {
  // Windows: install/update/uninstall itself from the zip (no unsigned installer exe to block).
  if (await installer.handleStartup({ hasLock: gotLock })) return app.quit();
  if (!gotLock) return app.quit();
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  allowCrossOrigin();
  decoder.start(app, ipcMain);
  startDvr();
  startTimeshift();
  remote.init({ app, ipcMain, isApp: (id) => appContents.has(id), window: () => win });
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
// The remote server never outlives the app.
app.on('will-quit', () => { void remote.shutdown(); });

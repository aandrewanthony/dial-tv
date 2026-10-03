// Dial TV desktop shell (Electron). Loads the built web app from dist/ and gives it
// what a browser can't: access to IPTV hosts that don't send CORS headers.
const { app, BrowserWindow, ipcMain, session, shell, Menu } = require('electron');
const path = require('node:path');

const isDev = !app.isPackaged && process.env.DIAL_DEV_URL;

// Separate profile (data + single-instance lock) for testing next to an installed copy.
if (process.env.DIAL_PROFILE) app.setPath('userData', path.join(app.getPath('temp'), 'dial-tv-' + process.env.DIAL_PROFILE));
let win;

/**
 * IPTV playlists, guides and streams almost never send CORS headers. Inside this
 * app's own session we add permissive CORS response headers so fetch()/hls.js work
 * against any provider. Only affects requests made by Dial TV itself.
 */
function allowCrossOrigin() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    // Per-request UA/Referer overrides sent by the player (from #EXTVLCOPT / Kodi pipe options).
    if (h['X-Dial-UA']) { h['User-Agent'] = h['X-Dial-UA']; delete h['X-Dial-UA']; }
    if (h['X-Dial-Referer']) { h['Referer'] = h['X-Dial-Referer']; delete h['X-Dial-Referer']; }
    cb({ requestHeaders: h });
  });
  ses.webRequest.onHeadersReceived((details, cb) => {
    if (details.url.startsWith('file:') || details.url.startsWith('devtools:')) return cb({});
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

  if (isDev) win.loadURL(process.env.DIAL_DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // External links open in the real browser; the app never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !(isDev && url.startsWith(process.env.DIAL_DEV_URL))) e.preventDefault();
  });
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

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.setAppUserModelId('com.dialtv.player'); // Windows notifications + taskbar grouping
  app.whenReady().then(() => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    allowCrossOrigin();
    createWindow();
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
}

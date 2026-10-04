// Minimal, explicit bridge from the web app to the desktop shell.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialDesktop', {
  secrets: {
    get: (name) => ipcRenderer.invoke('dial:secret-get', name),
    set: (name, value) => ipcRenderer.invoke('dial:secret-set', name, value),
    // Whether a secret is saved (for write-only ones like the ESPN cookies, which can't be read back).
    has: (name) => ipcRenderer.invoke('dial:secret-has', name),
  },
  platform: process.platform,
  setMiniPlayer: (on) => ipcRenderer.invoke('dial:mini-player', !!on),
  version: () => ipcRenderer.invoke('dial:version'),
  // Headers the shell adds to this stream's requests (playlist UA/Referer/Origin/Cookie, Basic auth).
  setStreamHeaders: (url, headers) => ipcRenderer.invoke('dial:stream-headers', String(url), headers ?? {}),
  // DVR: schedule/stop/remove recordings; the shell keeps the stream links (see electron/dvr.cjs).
  dvr: {
    list: () => ipcRenderer.invoke('dvr:list'),
    schedule: (job) => ipcRenderer.invoke('dvr:schedule', job),
    stop: (id) => ipcRenderer.invoke('dvr:stop', String(id)),
    remove: (id) => ipcRenderer.invoke('dvr:remove', String(id)),
    extend: (id, end) => ipcRenderer.invoke('dvr:extend', String(id), Number(end)),
    playUrl: (id) => ipcRenderer.invoke('dvr:play-url', String(id)),
    reveal: (id) => ipcRenderer.invoke('dvr:reveal', id == null ? null : String(id)),
    settings: (patch) => ipcRenderer.invoke('dvr:settings', patch ?? null),
    chooseFolder: () => ipcRenderer.invoke('dvr:choose-folder'),
    onChange: (fn) => {
      const h = (_e, snap) => fn(snap);
      ipcRenderer.on('dvr:changed', h);
      return () => ipcRenderer.removeListener('dvr:changed', h);
    },
  },
  decoder: {
    info: () => ipcRenderer.invoke('dial:decoder-info'),
    probe: (url, headers) => ipcRenderer.invoke('dial:probe', String(url), headers ?? {}),
    // opts: how to convert (preset, scale, deinterlace, hardware encoder, movie start/lead); validated in main.
    url: (src, headers, opts) => ipcRenderer.invoke('dial:decoder-url', String(src), headers ?? {}, opts ?? {}),
    infoFor: (src) => ipcRenderer.invoke('dial:decoder-info-for', String(src)),
  },
  // Pause & rewind live TV: a rolling local buffer of one channel (see electron/timeshift.cjs).
  timeshift: {
    start: (id, url, headers) => ipcRenderer.invoke('timeshift:start', String(id), String(url), headers ?? {}),
    stop: (id) => ipcRenderer.invoke('timeshift:stop', String(id)),
  },
  // Remote Control (phone on the LAN). Commands arrive already validated by the main process.
  remote: {
    status: () => ipcRenderer.invoke('dial:remote-status'),
    setEnabled: (on) => ipcRenderer.invoke('dial:remote-enable', on === true),
    revoke: (id) => ipcRenderer.invoke('dial:remote-revoke', String(id)),
    newCode: () => ipcRenderer.invoke('dial:remote-new-code'),
    publish: (state) => ipcRenderer.send('dial:remote-state', state),
    onCommand: (cb) => {
      const h = (_e, cmd, from) => cb(cmd, from);
      ipcRenderer.on('dial:remote-cmd', h);
      return () => ipcRenderer.removeListener('dial:remote-cmd', h);
    },
    onStatus: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on('dial:remote-status', h);
      return () => ipcRenderer.removeListener('dial:remote-status', h);
    },
  },
});

// A file dropped anywhere the app doesn't handle it must not navigate the window away.
const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragover', (e) => {
  if (hasFiles(e) && !e.defaultPrevented) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  }
});
window.addEventListener('drop', (e) => { if (hasFiles(e) && !e.defaultPrevented) e.preventDefault(); });

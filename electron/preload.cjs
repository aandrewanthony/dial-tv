// Minimal, explicit bridge from the web app to the desktop shell.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialDesktop', {
  platform: process.platform,
  setMiniPlayer: (on) => ipcRenderer.invoke('dial:mini-player', !!on),
  version: () => ipcRenderer.invoke('dial:version'),
  // Headers the shell adds to this stream's requests (playlist UA/Referer/Origin/Cookie, Basic auth).
  setStreamHeaders: (url, headers) => ipcRenderer.invoke('dial:stream-headers', String(url), headers ?? {}),
  decoder: {
    info: () => ipcRenderer.invoke('dial:decoder-info'),
    probe: (url, headers) => ipcRenderer.invoke('dial:probe', String(url), headers ?? {}),
    url: (src, headers) => ipcRenderer.invoke('dial:decoder-url', String(src), headers ?? {}),
    infoFor: (src) => ipcRenderer.invoke('dial:decoder-info-for', String(src)),
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

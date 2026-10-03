// Minimal, explicit bridge from the web app to the desktop shell.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialDesktop', {
  platform: process.platform,
  setMiniPlayer: (on) => ipcRenderer.invoke('dial:mini-player', !!on),
  version: () => ipcRenderer.invoke('dial:version'),
  decoder: {
    info: () => ipcRenderer.invoke('dial:decoder-info'),
    probe: (url, ua, ref) => ipcRenderer.invoke('dial:probe', url, ua, ref),
    url: (src, ua, ref) => ipcRenderer.invoke('dial:decoder-url', src, ua, ref),
  },
});

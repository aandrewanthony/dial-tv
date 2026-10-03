// Minimal, explicit bridge from the web app to the desktop shell.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialDesktop', {
  platform: process.platform,
  setMiniPlayer: (on) => ipcRenderer.invoke('dial:mini-player', !!on),
  version: () => ipcRenderer.invoke('dial:version'),
});

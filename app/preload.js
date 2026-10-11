'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  send: (channel, data) => ipcRenderer.send(channel, data),
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  on: (channel, cb) => { const h = (_e, d) => cb(d); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h); },
});

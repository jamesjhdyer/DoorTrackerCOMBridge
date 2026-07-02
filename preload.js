const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getPorts: () => ipcRenderer.invoke('get-ports'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  connectPort: (options) => ipcRenderer.invoke('connect-port', options),
  disconnectPort: () => ipcRenderer.invoke('disconnect-port'),
  onScan: (callback) => ipcRenderer.on('scan-received', (_event, data) => callback(data)),
  onStatus: (callback) => ipcRenderer.on('status-update', (_event, data) => callback(data))
});

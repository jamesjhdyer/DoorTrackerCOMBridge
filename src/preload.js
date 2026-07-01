const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('comBridge', {
  listPorts: () => ipcRenderer.invoke('list-ports'),
  connect: (path, baudRate) => ipcRenderer.invoke('connect-port', { path, baudRate }),
  disconnect: () => ipcRenderer.invoke('disconnect-port'),

  onStatus: (callback) => {
    ipcRenderer.on('port-status', (event, data) => callback(data));
  },
  onScan: (callback) => {
    ipcRenderer.on('scan-received', (event, data) => callback(data));
  }
});

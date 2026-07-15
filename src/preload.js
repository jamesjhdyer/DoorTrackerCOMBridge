const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('comBridge', {
  listPorts: () => ipcRenderer.invoke('list-ports'),
  connect: (settings) => ipcRenderer.invoke('connect-port', settings),
  disconnect: (tabId) => ipcRenderer.invoke('disconnect-port', { tabId }),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  onStatus: (callback) => {
    ipcRenderer.on('port-status', (event, data) => callback(data));
  },
  onScan: (callback) => {
    ipcRenderer.on('scan-received', (event, data) => callback(data));
  },
  onApiResult: (callback) => {
    ipcRenderer.on('scan-api-result', (event, data) => callback(data));
  }
});

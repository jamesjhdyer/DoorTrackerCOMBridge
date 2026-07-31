const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('comBridge', {
  listPorts: () => ipcRenderer.invoke('list-ports'),
  connect: (settings) => ipcRenderer.invoke('connect-port', settings),
  disconnect: (tabId) => ipcRenderer.invoke('disconnect-port', { tabId }),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  manualScan: (payload) => ipcRenderer.invoke('manual-scan', payload),

  listPrinters: () => ipcRenderer.invoke('list-printers'),
  getPrinterName: () => ipcRenderer.invoke('get-printer-name'),
  savePrinterName: (printerName) => ipcRenderer.invoke('save-printer-name', printerName),
  getPrinterStatus: (printerName) => ipcRenderer.invoke('get-printer-status', printerName),
  printTestPattern: (dims) => ipcRenderer.invoke('print-test-pattern', dims),
  reprintTestJob: (jobId) => ipcRenderer.invoke('test-reprint-job', { jobId }),

  onStatus: (callback) => {
    ipcRenderer.on('port-status', (event, data) => callback(data));
  },
  onScan: (callback) => {
    ipcRenderer.on('scan-received', (event, data) => callback(data));
  },
  onApiResult: (callback) => {
    ipcRenderer.on('scan-api-result', (event, data) => callback(data));
  },
  onPrintJobEvent: (callback) => {
    ipcRenderer.on('print-job-event', (event, data) => callback(data));
  }
});

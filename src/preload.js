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

// A separate namespace, deliberately - the Delivery Photos worker is an
// isolated process with its own settings and its own IPC surface (see
// main.js's "Delivery Photos" section); nothing above this line changes.
contextBridge.exposeInMainWorld('deliveryPhotos', {
  getStatus: () => ipcRenderer.invoke('get-delivery-photos-status'),
  getConfig: () => ipcRenderer.invoke('get-delivery-photos-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-delivery-photos-config', config),
  start: () => ipcRenderer.invoke('start-delivery-photos-service'),
  stop: () => ipcRenderer.invoke('stop-delivery-photos-service'),
  testStorage: () => ipcRenderer.invoke('test-delivery-photos-storage'),
  openPhotographsFolder: () => ipcRenderer.invoke('open-delivery-photographs-folder'),
  openLogsFolder: () => ipcRenderer.invoke('open-delivery-photos-logs-folder'),

  onStatus: (callback) => {
    ipcRenderer.on('delivery-photos-status', (event, status) => callback(status));
  }
});

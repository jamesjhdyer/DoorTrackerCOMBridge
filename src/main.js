const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { SerialPort } = require('serialport');

let mainWindow = null;
let activePort = null;
let readBuffer = '';

// Settings captured at connect time so each scan knows where to POST and
// how to label itself, independent of whether "Save Settings" was clicked.
let activeStationKey = '';
let activeApiUrl = '';
let activeBaudRate = null;

const API_TIMEOUT_MS = 8000;

const DEFAULT_SETTINGS = {
  comPort: 'COM5',
  baudRate: 19200,
  stationKey: 'frame_cutting',
  apiUrl: ''
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  closeActivePort();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ---- Settings persistence ----

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettingsFromDisk() {
  try {
    const raw = fs.readFileSync(settingsFilePath(), 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettingsToDisk(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  fs.mkdirSync(path.dirname(settingsFilePath()), { recursive: true });
  fs.writeFileSync(settingsFilePath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// ---- Serial port helpers ----

function sendStatus(status, message) {
  if (mainWindow) {
    mainWindow.webContents.send('port-status', { status, message: message || '' });
  }
}

function sendScan(portPath, value) {
  const id = randomUUID();

  if (mainWindow) {
    mainWindow.webContents.send('scan-received', {
      id,
      timestamp: new Date().toISOString(),
      port: portPath,
      value,
      station: activeStationKey
    });
  }

  postScanToApi(id, portPath, value);
}

function sendApiResult(id, status, message) {
  if (mainWindow) {
    mainWindow.webContents.send('scan-api-result', { id, status, message: message || '' });
  }
}

async function postScanToApi(id, portPath, value) {
  if (!activeApiUrl) {
    sendApiResult(id, 'error', 'No API URL configured — scan was not sent.');
    return;
  }

  const body = {
    code: value,
    station_key: activeStationKey,
    device: portPath,
    source: 'com_listener',
    baud_rate: activeBaudRate
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(activeApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    let bodyMessage = '';
    try {
      const data = await response.json();
      bodyMessage = (data && (data.message || data.error)) || '';
    } catch {
      // Response wasn't JSON — fall back to status text below.
    }

    if (response.ok) {
      sendApiResult(id, 'sent', bodyMessage || 'Sent');
    } else {
      sendApiResult(id, 'error', bodyMessage || `HTTP ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Request timed out' : err.message;
    sendApiResult(id, 'error', message);
  } finally {
    clearTimeout(timeoutId);
  }
}

function closeActivePort() {
  if (activePort && activePort.isOpen) {
    activePort.close();
  }
  activePort = null;
  readBuffer = '';
  activeStationKey = '';
  activeApiUrl = '';
  activeBaudRate = null;
}

// Splits incoming serial data on CR, LF, or CRLF. Any of the three counts
// as "end of scan" per the NT-1228BL's configurable suffix options.
function handleIncomingData(portPath, chunk) {
  readBuffer += chunk.toString('utf8');

  let breakIndex;
  while ((breakIndex = readBuffer.search(/[\r\n]/)) !== -1) {
    const scan = readBuffer.slice(0, breakIndex);
    readBuffer = readBuffer.slice(breakIndex + 1);

    if (scan.length > 0) {
      sendScan(portPath, scan);
    }
  }
}

// ---- IPC handlers ----

ipcMain.handle('list-ports', async () => {
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer || '',
    serialNumber: p.serialNumber || '',
    pnpId: p.pnpId || ''
  }));
});

ipcMain.handle('load-settings', async () => loadSettingsFromDisk());

ipcMain.handle('save-settings', async (event, settings) => {
  const saved = saveSettingsToDisk(settings || {});
  return { ok: true, settings: saved };
});

ipcMain.handle('connect-port', async (event, { path: portPath, baudRate, stationKey, apiUrl }) => {
  if (activePort && activePort.isOpen) {
    return { ok: false, error: 'Already connected. Disconnect first.' };
  }

  readBuffer = '';

  return new Promise((resolve) => {
    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });

    port.open((err) => {
      if (err) {
        sendStatus('error', `Failed to open ${portPath}: ${err.message}`);
        resolve({ ok: false, error: err.message });
        return;
      }

      activePort = port;
      activeStationKey = stationKey || '';
      activeApiUrl = (apiUrl || '').trim();
      activeBaudRate = baudRate;
      sendStatus('connected', `Connected to ${portPath} at ${baudRate} baud`);
      resolve({ ok: true });
    });

    port.on('data', (chunk) => handleIncomingData(portPath, chunk));

    port.on('error', (err) => {
      sendStatus('error', `Port error: ${err.message}`);
    });

    port.on('close', () => {
      if (activePort === port) {
        activePort = null;
        sendStatus('disconnected', `Port ${portPath} closed`);
      }
    });
  });
});

ipcMain.handle('disconnect-port', async () => {
  if (!activePort || !activePort.isOpen) {
    sendStatus('disconnected', 'No active connection');
    return { ok: true };
  }

  return new Promise((resolve) => {
    activePort.close((err) => {
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      activePort = null;
      readBuffer = '';
      activeStationKey = '';
      activeApiUrl = '';
      activeBaudRate = null;
      sendStatus('disconnected', 'Disconnected');
      resolve({ ok: true });
    });
  });
});

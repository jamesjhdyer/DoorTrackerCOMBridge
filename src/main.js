const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { SerialPort } = require('serialport');

let mainWindow = null;

// tabId -> { port, portPath, readBuffer, stationKey, apiUrl, baudRate }
// Each tab owns an independent SerialPort connection so multiple COM ports
// can be listened to at once from a single running app.
const connections = new Map();

const API_TIMEOUT_MS = 8000;

const DEFAULT_SETTINGS = {
  apiUrl: '',
  tabs: [
    { id: randomUUID(), comPort: 'COM5', baudRate: 19200, stationKey: 'frame_cutting' }
  ]
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
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
  closeAllConnections();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ---- Settings persistence ----

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Accepts either the current { apiUrl, tabs: [...] } shape or the older
// single-connection { comPort, baudRate, stationKey, apiUrl } shape so
// existing settings.json files on disk still load correctly.
function normalizeSettings(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return structuredClone(DEFAULT_SETTINGS);
  }

  if (!Array.isArray(parsed.tabs)) {
    return {
      apiUrl: parsed.apiUrl || '',
      tabs: [
        {
          id: randomUUID(),
          comPort: parsed.comPort || DEFAULT_SETTINGS.tabs[0].comPort,
          baudRate: parsed.baudRate || DEFAULT_SETTINGS.tabs[0].baudRate,
          stationKey: parsed.stationKey || DEFAULT_SETTINGS.tabs[0].stationKey
        }
      ]
    };
  }

  return {
    apiUrl: parsed.apiUrl || '',
    tabs: parsed.tabs.length > 0 ? parsed.tabs : structuredClone(DEFAULT_SETTINGS.tabs)
  };
}

function loadSettingsFromDisk() {
  try {
    const raw = fs.readFileSync(settingsFilePath(), 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return normalizeSettings(null);
  }
}

function saveSettingsToDisk(settings) {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(path.dirname(settingsFilePath()), { recursive: true });
  fs.writeFileSync(settingsFilePath(), JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

// ---- Serial port helpers ----

function sendStatus(tabId, status, message) {
  if (mainWindow) {
    mainWindow.webContents.send('port-status', { tabId, status, message: message || '' });
  }
}

function sendScan(tabId, portPath, value) {
  const id = randomUUID();
  const conn = connections.get(tabId);

  if (mainWindow) {
    mainWindow.webContents.send('scan-received', {
      tabId,
      id,
      timestamp: new Date().toISOString(),
      port: portPath,
      value,
      station: conn ? conn.stationKey : ''
    });
  }

  postScanToApi(tabId, id, portPath, value);
}

function sendApiResult(tabId, id, status, message) {
  if (mainWindow) {
    mainWindow.webContents.send('scan-api-result', { tabId, id, status, message: message || '' });
  }
}

async function postScanToApi(tabId, id, portPath, value) {
  const conn = connections.get(tabId);
  const apiUrl = conn ? conn.apiUrl : '';

  if (!apiUrl) {
    sendApiResult(tabId, id, 'error', 'No API URL configured — scan was not sent.');
    return;
  }

  const body = {
    code: value,
    station_key: conn.stationKey,
    device: portPath,
    source: 'com_listener',
    baud_rate: conn.baudRate
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
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
      sendApiResult(tabId, id, 'sent', bodyMessage || 'Sent');
    } else {
      sendApiResult(tabId, id, 'error', bodyMessage || `HTTP ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Request timed out' : err.message;
    sendApiResult(tabId, id, 'error', message);
  } finally {
    clearTimeout(timeoutId);
  }
}

function closeConnection(tabId) {
  const conn = connections.get(tabId);
  if (!conn) return;
  if (conn.port && conn.port.isOpen) {
    conn.port.close();
  }
  connections.delete(tabId);
}

function closeAllConnections() {
  for (const tabId of Array.from(connections.keys())) {
    closeConnection(tabId);
  }
}

// Splits incoming serial data on CR, LF, or CRLF. Any of the three counts
// as "end of scan" per the NT-1228BL's configurable suffix options.
function handleIncomingData(tabId, portPath, chunk) {
  const conn = connections.get(tabId);
  if (!conn) return;

  conn.readBuffer += chunk.toString('utf8');

  let breakIndex;
  while ((breakIndex = conn.readBuffer.search(/[\r\n]/)) !== -1) {
    const scan = conn.readBuffer.slice(0, breakIndex);
    conn.readBuffer = conn.readBuffer.slice(breakIndex + 1);

    if (scan.length > 0) {
      sendScan(tabId, portPath, scan);
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

ipcMain.handle('connect-port', async (event, { tabId, path: portPath, baudRate, stationKey, apiUrl }) => {
  if (!tabId) {
    return { ok: false, error: 'Missing tab id' };
  }

  const existing = connections.get(tabId);
  if (existing && existing.port && existing.port.isOpen) {
    return { ok: false, error: 'This tab is already connected. Disconnect first.' };
  }

  for (const [otherTabId, conn] of connections) {
    if (otherTabId !== tabId && conn.portPath === portPath && conn.port && conn.port.isOpen) {
      return { ok: false, error: `${portPath} is already connected in another tab.` };
    }
  }

  return new Promise((resolve) => {
    const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });

    port.open((err) => {
      if (err) {
        sendStatus(tabId, 'error', `Failed to open ${portPath}: ${err.message}`);
        resolve({ ok: false, error: err.message });
        return;
      }

      connections.set(tabId, {
        port,
        portPath,
        readBuffer: '',
        stationKey: stationKey || '',
        apiUrl: (apiUrl || '').trim(),
        baudRate
      });

      sendStatus(tabId, 'connected', `Connected to ${portPath} at ${baudRate} baud`);
      resolve({ ok: true });
    });

    port.on('data', (chunk) => handleIncomingData(tabId, portPath, chunk));

    port.on('error', (err) => {
      sendStatus(tabId, 'error', `Port error: ${err.message}`);
    });

    port.on('close', () => {
      const conn = connections.get(tabId);
      if (conn && conn.port === port) {
        connections.delete(tabId);
        sendStatus(tabId, 'disconnected', `Port ${portPath} closed`);
      }
    });
  });
});

ipcMain.handle('disconnect-port', async (event, { tabId } = {}) => {
  const conn = connections.get(tabId);
  if (!conn || !conn.port || !conn.port.isOpen) {
    connections.delete(tabId);
    sendStatus(tabId, 'disconnected', 'No active connection');
    return { ok: true };
  }

  return new Promise((resolve) => {
    conn.port.close((err) => {
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      connections.delete(tabId);
      sendStatus(tabId, 'disconnected', 'Disconnected');
      resolve({ ok: true });
    });
  });
});

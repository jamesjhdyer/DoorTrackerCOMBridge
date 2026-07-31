const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { SerialPort } = require('serialport');
const { deriveApiBase, fetchPendingJobs, reprintJob } = require('./print-job-client');
const { PrintJobProcessor } = require('./print-job-processor');
const { createPrintAttemptStore } = require('./print-attempt-store');
const printerSettings = require('./printer-settings');
const windowsPrinter = require('./printing/windows-printer');
const { buildTestPatternZpl } = require('./printing/zpl-image');

let mainWindow = null;

// tabId -> { port, portPath, readBuffer, stationKey, apiUrl, baudRate }
// Each tab owns an independent SerialPort connection so multiple COM ports
// can be listened to at once from a single running app.
const connections = new Map();

const API_TIMEOUT_MS = 8000;

// Durable record of job_ids physically submitted to the printer but not
// yet confirmed — survives a crash/restart. See print-attempt-store.js and
// print-job-processor.js's processOne() for how this closes the
// duplicate-print recovery gap.
const printAttemptStore = createPrintAttemptStore(path.join(app.getPath('userData'), 'print-attempts.json'));

// One shared processor for the whole app, not one per tab — printing must
// be sequential across every station/COM port, not just within one, so a
// job from one tab can never reach the physical printer at the same time
// as a job from another. See print-job-processor.js.
const printProcessor = new PrintJobProcessor({
  onEvent: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('print-job-event', event);
    }
  },
  priorAttemptStore: printAttemptStore
});

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

  // conn is only missing here if a 'data' event somehow fired outside an
  // open connection's lifetime — see connect-port's handler for why that
  // shouldn't happen in practice. Guard rather than let postScanToApi be
  // called with an undefined scan context.
  if (!conn) return;

  postScanToApi(tabId, id, {
    apiUrl: conn.apiUrl,
    stationKey: conn.stationKey,
    baudRate: conn.baudRate,
    device: portPath,
    source: 'com_listener'
  }, value);
}

function sendApiResult(tabId, id, status, message) {
  if (mainWindow) {
    mainWindow.webContents.send('scan-api-result', { tabId, id, status, message: message || '' });
  }
}

// The one and only path anything in this app uses to submit a scan to the
// website — a real COM-port scan (sendScan, above) and a manual test scan
// (the manual-scan IPC handler, below) both call this with the same shape
// of scan context, just sourced differently (from a live `connections`
// entry vs. straight from the renderer's current tab UI state). There is
// no second implementation of "what happens when a code is scanned".
async function postScanToApi(tabId, id, { apiUrl, stationKey, baudRate, device, source }, value) {
  if (!apiUrl) {
    sendApiResult(tabId, id, 'error', 'No API URL configured — scan was not sent.');
    return;
  }

  const body = {
    code: value,
    station_key: stationKey,
    device,
    source,
    baud_rate: baudRate
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
    let data = null;
    try {
      data = await response.json();
      bodyMessage = (data && (data.message || data.error)) || '';
    } catch {
      // Response wasn't JSON — fall back to status text below.
    }

    if (response.ok) {
      sendApiResult(tabId, id, 'sent', bodyMessage || 'Sent');
    } else {
      sendApiResult(tabId, id, 'error', bodyMessage || `HTTP ${response.status} ${response.statusText}`);
    }

    // Existing scan handling above is completely unchanged by this — a
    // response with no printJob (every station except Pre-Hung, and most
    // Pre-Hung scans) falls through here with nothing left to do, exactly
    // as before this feature existed.
    if (data && data.printJob && data.printJob.created) {
      printProcessor.enqueue(data.printJob, deriveApiBase(apiUrl));
    }
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Request timed out' : err.message;
    sendApiResult(tabId, id, 'error', message);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Recovers unfinished print jobs for whichever station this tab is
// configured as, and hands each one to the same printProcessor a fresh
// scan response would use — see print-job-processor.js's module comment
// for why that's the same pipeline rather than a second implementation.
// Called on every successful port connection (see the connect-port
// handler above); harmless/near-instant for a station that never has
// print jobs, since the website's response is just an empty list.
async function recoverPendingJobs(tabId) {
  const conn = connections.get(tabId);
  if (!conn || !conn.apiUrl) return;

  const apiBase = deriveApiBase(conn.apiUrl);
  if (!apiBase) return;

  const result = await fetchPendingJobs(apiBase, conn.stationKey);
  if (!result.ok) {
    sendStatus(tabId, 'connected', `Connected — pending print-job recovery failed: ${result.error}`);
    return;
  }

  for (const job of result.jobs) {
    printProcessor.enqueue(job, apiBase);
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

// Manual test scan — lets the operator simulate a scanner input for a tab
// without a physical scanner. Deliberately routed through the exact same
// postScanToApi() as a real COM scan (see sendScan/postScanToApi above):
// same request shape to the website, same handling of the response,
// including enqueuing any returned printJob into the same printProcessor a
// real Pre-Hung scan would use. The only differences are cosmetic —
// source/device are tagged 'manual_test' so these are distinguishable from
// real scanner activity in the website's logs, and the "port" shown in the
// UI is a fixed label instead of a COM path.
//
// stationKey/apiUrl are taken from the renderer's live tab UI state
// (passed in the payload) rather than from `connections`, since a tab does
// not need an open serial connection to submit a manual scan — that's the
// whole point of this feature on a dev machine or before a scanner/printer
// is wired up.
ipcMain.handle('manual-scan', async (event, { tabId, code, stationKey, apiUrl } = {}) => {
  if (!tabId) return { ok: false, error: 'Missing tab id' };

  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) return { ok: false, error: 'Enter a code to submit.' };

  const id = randomUUID();
  if (mainWindow) {
    mainWindow.webContents.send('scan-received', {
      tabId,
      id,
      timestamp: new Date().toISOString(),
      port: 'Manual Entry',
      value: trimmed,
      station: stationKey || ''
    });
  }

  await postScanToApi(tabId, id, {
    apiUrl: (apiUrl || '').trim(),
    stationKey: stationKey || '',
    baudRate: undefined,
    device: 'manual_test',
    source: 'manual_test'
  }, trimmed);

  return { ok: true };
});

ipcMain.handle('load-settings', async () => loadSettingsFromDisk());

ipcMain.handle('save-settings', async (event, settings) => {
  const saved = saveSettingsToDisk(settings || {});
  return { ok: true, settings: saved };
});

// ---- Printer configuration + manual test IPC handlers ----
// See src/printing/windows-printer.js — every one of these is a no-op-ish
// "not supported on this platform" result on macOS, never a crash, so
// normal development doesn't need Windows printer access to succeed.

ipcMain.handle('list-printers', async () => windowsPrinter.listPrinters());

ipcMain.handle('get-printer-name', async () => printerSettings.getPrinterName());

ipcMain.handle('save-printer-name', async (event, printerName) => {
  printerSettings.setPrinterName(printerName || '');
  return { ok: true, printerName: printerSettings.getPrinterName() };
});

ipcMain.handle('get-printer-status', async (event, printerName) => windowsPrinter.getPrinterStatus(printerName));

// Manual diagnostic print — a border+crosshair calibration pattern at
// whatever width/height the operator asks for (defaulting to today's
// known DELIVERY_STANDARD size in the UI, not hard-coded here), submitted
// through the exact same printer-service validation/submission path a
// real job uses, so a successful test print is a genuine end-to-end proof
// the configured printer works.
ipcMain.handle('print-test-pattern', async (event, { widthMm, heightMm }) => {
  try {
    const zpl = buildTestPatternZpl({ widthMm: Number(widthMm), heightMm: Number(heightMm), dpi: 203 });
    const printerName = printerSettings.getPrinterName();
    if (!printerName) {
      return { ok: false, error: 'No printer is configured.' };
    }
    const status = await windowsPrinter.getPrinterStatus(printerName);
    if (!status.supported) {
      return { ok: false, error: `Printing is only implemented on Windows (this is ${process.platform}).` };
    }
    if (!status.found) {
      return { ok: false, error: `Configured printer "${printerName}" was not found.` };
    }
    if (status.offline) {
      return { ok: false, error: `Printer "${printerName}" is offline.` };
    }
    await windowsPrinter.sendRawData(printerName, Buffer.from(zpl, 'ascii'));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Reprints a real, already-rendered delivery label (via the website's
// existing reprint endpoint) through the normal print-job pipeline — lets
// the printer be tested against a genuine label image without a real
// production scan. Requires apiUrl to already be configured (same source
// as every other website call this app makes).
ipcMain.handle('test-reprint-job', async (event, { jobId }) => {
  const { apiUrl } = loadSettingsFromDisk();
  const apiBase = deriveApiBase(apiUrl);
  if (!apiBase) {
    return { ok: false, error: 'No API URL configured.' };
  }
  const result = await reprintJob(apiBase, jobId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  printProcessor.enqueue(result.job, apiBase);
  return { ok: true };
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

      // Fire-and-forget — recovery must not delay the connect() response.
      // Asked for on every connection regardless of station: the website
      // is what decides which stations ever have print jobs (only
      // Pre-Hung does today), so this never needs to hard-code that here.
      recoverPendingJobs(tabId);
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

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SerialPort } = require('serialport');

let mainWindow = null;
let activePort = null;
let readBuffer = '';

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

// ---- Serial port helpers ----

function sendStatus(status, message) {
  if (mainWindow) {
    mainWindow.webContents.send('port-status', { status, message: message || '' });
  }
}

function sendScan(portPath, value) {
  if (mainWindow) {
    mainWindow.webContents.send('scan-received', {
      timestamp: new Date().toISOString(),
      port: portPath,
      value
    });
  }
}

function closeActivePort() {
  if (activePort && activePort.isOpen) {
    activePort.close();
  }
  activePort = null;
  readBuffer = '';
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

ipcMain.handle('connect-port', async (event, { path: portPath, baudRate }) => {
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
      sendStatus('disconnected', 'Disconnected');
      resolve({ ok: true });
    });
  });
});

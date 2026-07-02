const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { SerialPort } = require('serialport');

let mainWindow;
let activePort = null;
let activePortPath = '';
let incomingBuffer = '';
let connectionStatus = 'Disconnected';
let connectionMessage = 'Ready to connect.';

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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function broadcastStatus(status, message) {
  connectionStatus = status;
  connectionMessage = message;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', { status, message });
  }
}

function handleIncomingData(chunk) {
  incomingBuffer += chunk.toString('utf8');

  const parts = incomingBuffer.split(/[\r\n]+/);
  incomingBuffer = parts.pop() || '';

  for (const part of parts) {
    const value = part.trim();
    if (!value) {
      continue;
    }

    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      port: activePortPath || 'Unknown',
      value
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scan-received', entry);
    }
  }
}

async function disconnectPort() {
  if (!activePort) {
    broadcastStatus('Disconnected', 'No active COM port connection.');
    return { ok: true };
  }

  try {
    if (activePort.isOpen) {
      await new Promise((resolve, reject) => {
        activePort.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    activePort = null;
    activePortPath = '';
    broadcastStatus('Disconnected', 'Disconnected from COM port.');
    return { ok: true };
  } catch (error) {
    broadcastStatus('Error', `Disconnect failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

ipcMain.handle('get-ports', async () => {
  try {
    const ports = await SerialPort.list();
    return ports.map((port) => ({
      path: port.path,
      manufacturer: port.manufacturer || 'Unknown'
    }));
  } catch (error) {
    return [];
  }
});

ipcMain.handle('get-status', async () => ({
  status: connectionStatus,
  message: connectionMessage
}));

ipcMain.handle('connect-port', async (_event, { portPath, baudRate }) => {
  try {
    await disconnectPort();

    activePortPath = portPath;
    activePort = new SerialPort({
      path: portPath,
      baudRate: Number(baudRate || 19200),
      autoOpen: false,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    });

    activePort.on('error', (error) => {
      broadcastStatus('Error', `COM port error: ${error.message}`);
    });

    activePort.on('close', () => {
      if (connectionStatus !== 'Error') {
        broadcastStatus('Disconnected', 'COM port closed.');
      }
    });

    activePort.on('data', handleIncomingData);

    await new Promise((resolve, reject) => {
      activePort.open((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

    broadcastStatus('Connected', `Listening on ${portPath}`);
    return { ok: true };
  } catch (error) {
    activePort = null;
    activePortPath = '';
    broadcastStatus('Error', `Unable to open ${portPath}: ${error.message}`);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('disconnect-port', async () => disconnectPort());

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (activePort && activePort.isOpen) {
    await disconnectPort();
  }
});

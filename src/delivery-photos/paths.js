'use strict';

// Where the Delivery Photos worker keeps its own small files (settings,
// status, logs, certificates, the local spool). The worker runs as a plain
// forked Node child process (not Electron itself), so it has no access to
// Electron's app.getPath('userData') directly - main.js computes that path
// once (it DOES have Electron access) and passes it down via the
// DELIVERY_PHOTOS_HOME environment variable when it forks the worker. See
// main.js's startWorker().
//
// Falling back to a local ./data folder (when the variable is absent) makes
// every module here runnable and testable as plain Node, with no Electron
// involved at all - the same pattern DoorTrackerPhotoBridge used.

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

function homeDir() {
  return process.env.DELIVERY_PHOTOS_HOME ? nodePath.resolve(process.env.DELIVERY_PHOTOS_HOME) : nodePath.resolve(__dirname, '..', '..', 'data', 'delivery-photos');
}

const configPath = () => nodePath.join(homeDir(), 'config.json');
const stateDir = () => nodePath.join(homeDir(), 'state');
const statusPath = () => nodePath.join(stateDir(), 'status.json');
const lockPath = () => nodePath.join(stateDir(), 'worker.lock');
const spoolDir = () => nodePath.join(homeDir(), 'spool');
const logsDirPath = () => nodePath.join(homeDir(), 'logs');
const certsDir = () => nodePath.join(homeDir(), 'certs');

// Creates the logs folder (this program's OWN folder, never the network
// share) and returns where it actually ended up. If that folder is
// read-only, falls back to the OS temp folder and says so, rather than
// failing outright - a worker that cannot log must still be able to run.
function ensureLogsDir() {
  const primary = logsDirPath();
  try {
    fs.mkdirSync(primary, { recursive: true });
    fs.accessSync(primary, fs.constants.W_OK);
    return { dir: primary, fellBack: false };
  } catch {
    const fallback = nodePath.join(os.tmpdir(), 'DeliveryPhotos-logs');
    fs.mkdirSync(fallback, { recursive: true });
    return { dir: fallback, fellBack: true };
  }
}

module.exports = { homeDir, configPath, stateDir, statusPath, lockPath, spoolDir, logsDirPath, certsDir, ensureLogsDir };

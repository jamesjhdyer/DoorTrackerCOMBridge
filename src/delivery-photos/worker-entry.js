#!/usr/bin/env node
'use strict';

// The Delivery Photos worker: a separate, isolated process the Electron main
// process forks and supervises (see main.js's startDeliveryPhotosWorker()).
// It never shares memory or an event loop with the scanner/printer code - a
// problem here (a hung network drive, a crash) can never stall a COM port
// read or a print job, and the reverse is equally true.
//
// Talks to the parent over the fork's own IPC channel only:
//   parent -> worker   { cmd: 'reload' }                  re-read settings and (re)start the servers
//             worker    { cmd: 'stop' }                    stop the servers, then this process exits
//   worker  -> parent   { event: 'status', status }        the current status.json contents, on every change
//
// Never talks to anything outside the workshop network - this process makes
// no outbound requests of its own at all (only the mDNS responder and the
// two local listeners, both LAN-only).

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createStatusFile } = require('./status');
const { acquireLock } = require('./lock');
const { ensureLogsDir, statusPath, lockPath, spoolDir, certsDir } = require('./paths');
const { ensureCertificates } = require('./certs');
const { advertise } = require('./mdns');
const { startServers } = require('./http-server');
const { runInWorker } = require('./worker-runner');

const DEV_OPTIONS = {
  allowDriveLetter: process.env.DELIVERY_PHOTOS_ALLOW_DRIVE_LETTER === '1',
  platform: process.env.DELIVERY_PHOTOS_PLATFORM || undefined // test-only: exercise Windows path rules on any OS
};

class Runtime {
  constructor() {
    this.status = createStatusFile(statusPath());
    this.lock = null;
    this.logger = null;
    this.mdnsHandle = null;
    this.serverHandle = null;
    this.stopped = false;
  }

  report(patch) {
    const current = this.status.write(patch);
    if (process.send) process.send({ event: 'status', status: current });
    return current;
  }

  async stopServers() {
    if (this.mdnsHandle) {
      await this.mdnsHandle.stop().catch(() => {});
      this.mdnsHandle = null;
    }
    if (this.serverHandle) {
      await this.serverHandle.close().catch(() => {});
      this.serverHandle = null;
    }
  }

  // (Re)reads settings and (re)starts the servers to match. Safe to call
  // again after a settings change (e.g. the hostname or archive folder was
  // just edited in the UI) - it always stops whatever was running first.
  async reload() {
    await this.stopServers();

    const result = loadConfig(DEV_OPTIONS);
    if (!result.ok) {
      const message = result.notSetUp ? 'Not set up yet.' : result.errors.join(' ');
      this.report({ state: 'not_configured', lastError: message, hostname: '', port: null });
      return;
    }
    const config = result.config;

    if (!this.logger) {
      const logs = ensureLogsDir();
      this.logger = createLogger({ dir: logs.dir, roots: [config.photoRoot] });
    }

    let credentials;
    try {
      credentials = ensureCertificates(certsDir(), config.hostname);
    } catch (err) {
      this.report({ state: 'error', lastError: `Could not prepare local HTTPS (${err.message}).` });
      return;
    }

    try {
      this.serverHandle = startServers({
        config,
        credentials,
        runWorker: runInWorker,
        logger: this.logger,
        spoolDir: spoolDir(),
        allowDriveLetter: DEV_OPTIONS.allowDriveLetter
      });
      await this.serverHandle.listen();
    } catch (err) {
      this.report({ state: 'error', lastError: `Could not start the local server (${err.message}).` });
      return;
    }

    this.mdnsHandle = advertise({ hostname: config.hostname, port: config.port });

    this.report({
      state: 'running',
      hostname: config.hostname,
      port: config.port,
      photoRoot: config.photoRoot,
      startedAt: new Date().toISOString(),
      lastError: '',
      filedToday: this.status.get().filedToday || 0,
      failedToday: this.status.get().failedToday || 0
    });
    this.logger.info(`Delivery Photos running: https://${config.hostname}:${config.port}/`);
  }

  async stop() {
    this.stopped = true;
    await this.stopServers();
    this.report({ state: 'stopped' });
    if (this.lock) this.lock.release();
  }
}

async function main() {
  const lock = acquireLock(lockPath());
  const runtime = new Runtime();
  if (!lock.ok) {
    runtime.report({ state: 'error', lastError: `Another Delivery Photos worker is already running (process ${lock.pid}).` });
    process.exitCode = 1;
    return;
  }
  runtime.lock = lock;

  const fatal = (label) => (err) => {
    const message = `${label}: ${err && err.stack ? err.stack : err}`;
    if (runtime.logger) runtime.logger.error(message);
    else console.error(message);
    runtime.report({ state: 'error', lastError: `${label}, restarting` });
    lock.release();
    process.exit(1);
  };
  process.on('uncaughtException', fatal('Unexpected error'));
  process.on('unhandledRejection', fatal('Unexpected error (unhandled promise rejection)'));

  process.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.cmd === 'reload') runtime.reload().catch(fatal('Could not apply settings'));
    else if (message.cmd === 'stop') runtime.stop().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => runtime.stop().then(() => process.exit(0)));

  await runtime.reload();
  const touch = setInterval(() => lock.touch(), 60000);
  touch.unref?.();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { Runtime };

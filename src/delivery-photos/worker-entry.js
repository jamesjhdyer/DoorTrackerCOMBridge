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
//   worker  -> parent   { event: 'tracking-pending' }      a delivery-photo tracking event was just queued (see tracking.js) -
//                                                            a nudge only; main.js's own periodic sweep is what actually syncs it
//
// Never talks to anything outside the workshop network itself - this process
// makes no outbound internet requests of its own at all (only the mDNS
// responder and the two local listeners, both LAN-only). The one exception
// by design: delivery-photo tracking events are written to a local queue
// folder ONLY (see tracking.js) - syncing that queue to Google Sheets over
// the internet is main.js's job, not this process's, specifically so this
// invariant never has to change.

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createStatusFile } = require('./status');
const { acquireLock } = require('./lock');
const { ensureLogsDir, statusPath, lockPath, spoolDir, certsDir, devicesPath, trackingQueueDir, filedLogDir } = require('./paths');
const { ensureCertificates } = require('./certs');
const { advertise } = require('./mdns');
const { startServers } = require('./http-server');
const { runInWorker } = require('./worker-runner');
const { PairingManager } = require('./auth');
const { ConcurrencyLimiter } = require('./concurrency');

const DEV_OPTIONS = {
  platform: process.env.DELIVERY_PHOTOS_PLATFORM || undefined // test-only: exercise Windows path rules on any OS
};

// How often the archive root is re-checked while the worker is running, so a
// mapped drive that was not yet reconnected at startup (or that drops out
// later) is noticed and reported without anyone needing to restart anything.
// Kept short but not tight: fast enough to feel responsive after logging in,
// far apart enough not to hammer a real network share. Overridable only for
// the automated tests (so "retry once it becomes available" can be proven in
// well under a second instead of really waiting 20 real seconds) - never set
// in production, see main.js's DELIVERY_PHOTOS_DEV_ENV_VARS.
const DRIVE_PROBE_INTERVAL_MS = Number(process.env.DELIVERY_PHOTOS_PROBE_INTERVAL_MS) || 20000;
const DRIVE_PROBE_TIMEOUT_MS = 10000;

class Runtime {
  constructor() {
    this.status = createStatusFile(statusPath());
    this.lock = null;
    this.logger = null;
    this.mdnsHandle = null;
    this.serverHandle = null;
    this.probeTimer = null;
    this.probing = false;
    this.stopped = false;
    // Live for the whole process, not recreated on every reload(): paired
    // devices are already persisted to disk (see auth.js) and reload() must
    // never un-pair every iPad just because a setting changed, and a
    // pairing code in progress on screen must survive an unrelated reload.
    this.pairing = new PairingManager({ devicesPath: devicesPath() });
    this.limiter = new ConcurrencyLimiter();
  }

  report(patch) {
    const current = this.status.write(patch);
    if (process.send) process.send({ event: 'status', status: current });
    return current;
  }

  async stopServers() {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.mdnsHandle) {
      await this.mdnsHandle.stop().catch(() => {});
      this.mdnsHandle = null;
    }
    if (this.serverHandle) {
      await this.serverHandle.close().catch(() => {});
      this.serverHandle = null;
    }
  }

  // Read-only reachability check, run through the same isolated, hard-timeout
  // forked worker every real archive operation uses (see worker-runner.js) -
  // a drive that has stopped answering can only ever hang THIS probe, never
  // the running HTTPS server or a photo already mid-upload. Runs once right
  // after startup and then on DRIVE_PROBE_INTERVAL_MS, so a drive that was
  // not yet reconnected (e.g. right after Windows login) is picked up
  // automatically once it appears - no restart needed.
  async probeDrive(config) {
    if (this.probing) return; // never overlap a probe with a still-running one
    this.probing = true;
    try {
      const result = await runInWorker('probe', { root: config.photoRoot, platform: DEV_OPTIONS.platform }, { timeoutMs: DRIVE_PROBE_TIMEOUT_MS });
      const freeGb = Number.isFinite(result.freeBytes) ? Math.round(result.freeBytes / (1024 ** 3)) : undefined;
      this.report({ shareOk: true, freeGb, lastError: '' });
    } catch (err) {
      this.report({ shareOk: false, lastError: (err && err.message) || 'the archive folder is not reachable' });
    } finally {
      this.probing = false;
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
        pairing: this.pairing,
        limiter: this.limiter,
        queueDir: trackingQueueDir(),
        filedLogDir: filedLogDir()
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
      pairedDevices: this.pairing.pairedCount()
    });
    this.logger.info(`Delivery Photos running: https://${config.hostname}:${config.port}/`);

    // Checked once immediately (requirement: known on startup whether the
    // archive folder is reachable, e.g. a mapped drive not yet reconnected
    // after login) and then kept current on an interval for as long as the
    // worker keeps running - see probeDrive() above.
    await this.probeDrive(config);
    this.probeTimer = setInterval(() => this.probeDrive(config), DRIVE_PROBE_INTERVAL_MS);
    this.probeTimer.unref?.();
  }

  async stop() {
    this.stopped = true;
    await this.stopServers();
    this.report({ state: 'stopped' });
    if (this.lock) this.lock.release();
  }

  // The two pairing-management actions the Electron UI's "Pair a new iPad"
  // and "Reset pairing" buttons drive (see main.js) - neither touches the
  // running servers, settings, or network/certificate setup at all, only
  // the pairing state kept in this.pairing (see auth.js).
  generatePairingCode() {
    const { code, expiresAt } = this.pairing.generateCode();
    return { code, expiresAt };
  }

  revokeDevices() {
    this.pairing.revokeAll();
    this.report({ pairedDevices: 0 });
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
    else if (message.cmd === 'generate-pairing-code') {
      const { code, expiresAt } = runtime.generatePairingCode();
      if (process.send) process.send({ event: 'pairing-code', requestId: message.requestId, code, expiresAt });
    } else if (message.cmd === 'revoke-devices') {
      runtime.revokeDevices();
      if (process.send) process.send({ event: 'devices-revoked', requestId: message.requestId });
    }
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

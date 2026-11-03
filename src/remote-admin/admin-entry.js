#!/usr/bin/env node
'use strict';

// The Remote Admin process: a separate, isolated process the Electron main
// process forks and supervises (see main.js's startRemoteAdmin()), exactly as
// it does the Delivery Photos worker. All of the network-facing work - TLS,
// HTTP parsing, sign-in, sessions - happens HERE, never in the main process
// that reads the scanners' serial ports and submits print jobs. A crash or a
// bug in this process can only take the admin page down (main.js restarts
// it); it cannot stall a COM port read or a print job.
//
// It can only ASK the main process to do one of the fixed actions in
// actions.js, over the fork's own IPC channel:
//   worker -> parent   { type: 'request', requestId, action, params, meta }
//   parent -> worker   { type: 'response', requestId, reply }
//   parent -> worker   { cmd: 'reload' }            re-read config.json and (re)start or stop the listener
//                      { cmd: 'revoke-sessions' }   sign every browser out (e.g. the password was changed)
//                      { cmd: 'stop' }              close the listener, then exit
//   worker -> parent   { event: 'status', status }  { state: 'running'|'off'|'error', port, urls, caFingerprint, lastError }

const { randomUUID } = require('node:crypto');
const { homeDir, configPath, passwordPath, certsDir, loadAdminConfig, readPasswordRecord } = require('./admin-config');
const { ensureAdminCertificates, desiredNames } = require('./admin-certs');
const { createAdminServer } = require('./admin-server');
const { SessionStore, LoginLimiter, RequestLimiter } = require('./admin-auth');
const { adminUrls } = require('./net-guard');
const { createLogger } = require('../delivery-photos/logger');

const MAIN_REPLY_TIMEOUT_MS = 30000;
const CERT_CHECK_INTERVAL_MS = 10 * 60 * 1000;

class Runtime {
  constructor() {
    this.home = homeDir();
    this.logsDir = process.env.REMOTE_ADMIN_LOGS_DIR || this.home;
    this.audit = createLogger({ dir: this.logsDir, prefix: 'remote-admin' });
    this.handle = null;
    this.port = null;
    this.tlsFingerprint = null;
    this.certTimer = null;
    this.pending = new Map(); // requestId -> { resolve, reject, timer }
    // Live for the whole process, not recreated on reload(): a settings
    // reload must never reset the failed-sign-in count or sign people out.
    this.sessions = new SessionStore();
    this.loginLimiter = new LoginLimiter();
    this.requestLimiter = new RequestLimiter();
  }

  report(status) {
    if (process.send) process.send({ event: 'status', status });
  }

  callMain(action, params, meta) {
    if (!process.send) return Promise.reject(new Error('The COM Bridge is not connected.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('The COM Bridge did not answer in time.'));
      }, MAIN_REPLY_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      process.send({ type: 'request', requestId, action, params, meta });
    });
  }

  onResponse(message) {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message.reply);
  }

  async stopServer() {
    clearInterval(this.certTimer);
    this.certTimer = null;
    if (this.handle) {
      await this.handle.close().catch(() => {});
      this.handle = null;
      this.port = null;
    }
  }

  // A new LAN address (DHCP) means a new certificate, swapped in without
  // dropping the listener or anyone's session.
  refreshCertificate() {
    try {
      this.handle?.setCredentials(ensureAdminCertificates(certsDir(this.home), desiredNames()));
    } catch (err) {
      this.audit.warn(`Could not refresh the Remote Admin certificate: ${err.message}`);
    }
  }

  async reload() {
    const config = loadAdminConfig(configPath(this.home));
    const hasPassword = Boolean(readPasswordRecord(passwordPath(this.home)));
    if (!config.enabled || !hasPassword) {
      await this.stopServer();
      this.report({ state: 'off', lastError: config.enabled ? 'No admin password has been set.' : '' });
      return;
    }
    if (this.handle && this.port === config.port) {
      this.refreshCertificate();
      this.report(this.runningStatus());
      return;
    }
    await this.stopServer();

    let tls;
    try {
      tls = ensureAdminCertificates(certsDir(this.home), desiredNames());
    } catch (err) {
      this.report({ state: 'error', port: config.port, lastError: `Could not prepare HTTPS (${err.message}).` });
      return;
    }

    const handle = createAdminServer({
      tls,
      port: config.port,
      getPasswordRecord: () => readPasswordRecord(passwordPath(this.home)),
      callMain: (action, params, meta) => this.callMain(action, params, meta),
      audit: this.audit,
      logSources: {
        'com-bridge': { dir: this.logsDir, prefix: 'com-bridge' },
        'remote-admin': { dir: this.logsDir, prefix: 'remote-admin' }
      },
      sessions: this.sessions,
      loginLimiter: this.loginLimiter,
      requestLimiter: this.requestLimiter
    });
    try {
      await handle.listen();
    } catch (err) {
      const reason = err && err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use by another program - choose a different Remote Admin port.` : `Could not start (${err && err.message}).`;
      this.report({ state: 'error', port: config.port, lastError: reason });
      return;
    }
    this.handle = handle;
    this.port = config.port;
    this.tlsFingerprint = tls.caFingerprint;
    this.certTimer = setInterval(() => this.refreshCertificate(), CERT_CHECK_INTERVAL_MS);
    this.certTimer.unref?.();
    this.audit.info(`Remote Admin listening on port ${config.port}.`);
    this.report(this.runningStatus());
  }

  runningStatus() {
    return { state: 'running', port: this.port, urls: adminUrls(this.port), caFingerprint: this.tlsFingerprint, lastError: '' };
  }

  revokeSessions() {
    this.sessions.clear();
    this.audit.info('AUDIT action=revoke-sessions source=local-app result=success');
  }
}

async function main() {
  const runtime = new Runtime();

  const fatal = (label) => (err) => {
    runtime.audit.error(`${label}: ${err && err.stack ? err.stack : err}`);
    runtime.report({ state: 'error', lastError: `${label}, restarting` });
    process.exit(1);
  };
  process.on('uncaughtException', fatal('Unexpected error'));
  process.on('unhandledRejection', fatal('Unexpected error (unhandled promise rejection)'));

  process.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'response') runtime.onResponse(message);
    else if (message.cmd === 'reload') runtime.reload().catch(fatal('Could not apply settings'));
    else if (message.cmd === 'revoke-sessions') runtime.revokeSessions();
    else if (message.cmd === 'stop') runtime.stopServer().then(() => process.exit(0));
  });
  // The parent going away (the app quit or crashed) must never leave an
  // orphaned listener behind.
  process.on('disconnect', () => runtime.stopServer().then(() => process.exit(0)));
  process.on('SIGTERM', () => runtime.stopServer().then(() => process.exit(0)));

  await runtime.reload();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { Runtime };

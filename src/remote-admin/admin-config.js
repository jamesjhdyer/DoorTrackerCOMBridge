'use strict';

// Where Remote Admin keeps its own small files, and its two settings:
// whether it is switched on, and which port it listens on. Changed ONLY from
// the Windows app on this PC (see main.js) - Remote Admin itself can never
// change its own port, switch itself on or off, or change its own password,
// so a browser session can never lock the operator out or widen its access.
//
// Like the Delivery Photos worker, the Remote Admin process is a plain forked
// Node child with no access to Electron's app.getPath('userData'); main.js
// passes the folder down in REMOTE_ADMIN_HOME. Falling back to a local
// ./data folder keeps every module here runnable and testable as plain Node.

const fs = require('node:fs');
const nodePath = require('node:path');

const DEFAULTS = Object.freeze({
  enabled: false,
  // 8443/8444 are Delivery Photos' default HTTPS and trust-profile ports.
  port: 8445
});

function homeDir() {
  return process.env.REMOTE_ADMIN_HOME ? nodePath.resolve(process.env.REMOTE_ADMIN_HOME) : nodePath.resolve(__dirname, '..', '..', 'data', 'remote-admin');
}

const configPath = (home = homeDir()) => nodePath.join(home, 'config.json');
// Only a salted scrypt hash - see admin-auth.js's hashPassword.
const passwordPath = (home = homeDir()) => nodePath.join(home, 'admin-password.json');
const certsDir = (home = homeDir()) => nodePath.join(home, 'certs');

function validateAdminConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const enabled = input.enabled === undefined ? DEFAULTS.enabled : Boolean(input.enabled);
  const port = input.port === undefined || input.port === '' || input.port === null ? DEFAULTS.port : Number(input.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) errors.push('The Remote Admin port must be a whole number from 1024 to 65535.');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { enabled, port } };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// A missing or damaged file reads as the defaults - which means switched off.
function loadAdminConfig(filePath = configPath()) {
  const result = validateAdminConfig(readJson(filePath) || {});
  return result.ok ? result.config : { ...DEFAULTS };
}

function writeJsonAtomic(filePath, value, mode) {
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  fs.renameSync(temp, filePath);
}

function saveAdminConfig(config, filePath = configPath()) {
  writeJsonAtomic(filePath, config);
}

function readPasswordRecord(filePath = passwordPath()) {
  const record = readJson(filePath);
  return record && typeof record === 'object' && record.scheme ? record : null;
}

function savePasswordRecord(record, filePath = passwordPath()) {
  writeJsonAtomic(filePath, record, 0o600);
}

module.exports = { DEFAULTS, homeDir, configPath, passwordPath, certsDir, validateAdminConfig, loadAdminConfig, saveAdminConfig, readPasswordRecord, savePasswordRecord };

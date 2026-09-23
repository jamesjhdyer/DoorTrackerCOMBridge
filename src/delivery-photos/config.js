'use strict';

// The Delivery Photos worker's settings: the local hostname the iPad reaches
// it on, which port it listens on, and the network archive folder. There is
// no website address and no API key here at all - this worker never talks to
// anything outside the workshop network.

const fs = require('node:fs');
const nodePath = require('node:path');
const { classifyRoot, normalizeRootInput } = require('./safe-path');
const { configPath } = require('./paths');

const DEFAULTS = Object.freeze({
  hostname: 'door-tracker.local',
  port: 8443,
  autoStart: true,
  minFreeGb: 2,
  operationTimeoutSeconds: 120,
  maxPhotoBytes: 20 * 1000 * 1000 // generous: this is a local upload, not going through any hosted request-size limit
});

// A single DNS label (letters/digits/hyphen, not starting/ending with a
// hyphen) followed by ".local" - kept simple and unambiguous rather than
// accepting arbitrary multi-label names, since this is also the mDNS service
// name the worker advertises.
const HOSTNAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.local$/;

// Returns { ok: true, config } or { ok: false, errors: [...] } (every
// problem at once, in plain language). `allowDriveLetter` and `platform`
// exist for the automated tests and local development only - see
// classifyRoot in safe-path.js.
function validateConfig(raw, options = {}) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};

  const hostname = String(input.hostname || '').trim().toLowerCase();
  if (!HOSTNAME_PATTERN.test(hostname)) {
    errors.push('The local address must be a single word ending in ".local", for example "door-tracker.local" (letters, digits and hyphens only).');
  }

  const port = input.port === undefined || input.port === '' ? DEFAULTS.port : Number(input.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    errors.push('The port must be a whole number from 1024 to 65535.');
  }

  const photoRoot = normalizeRootInput(String(input.photoRoot || ''));
  const rootInfo = classifyRoot(photoRoot, options.platform);
  if (!rootInfo.ok) errors.push(`The archive folder is not usable: ${rootInfo.reason}`);
  else if (rootInfo.kind === 'drive-letter' && !options.allowDriveLetter) {
    errors.push(`The archive folder is a mapped drive letter (${rootInfo.drive}:). Drive letters depend on who is logged in, and this worker may run when nobody is. Use the \\\\server\\share\\... path.`);
  }

  const autoStart = input.autoStart === undefined ? DEFAULTS.autoStart : Boolean(input.autoStart);

  const number = (name, label, min, max) => {
    const value = input[name] === undefined || input[name] === '' || input[name] === null ? DEFAULTS[name] : Number(input[name]);
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push(`${label} must be a number from ${min} to ${max}.`);
      return DEFAULTS[name];
    }
    return value;
  };
  const minFreeGb = number('minFreeGb', 'The minimum free space (GB)', 0, 100000);
  const operationTimeoutSeconds = number('operationTimeoutSeconds', 'The network-drive time limit (seconds)', 20, 900);
  const maxPhotoBytes = number('maxPhotoBytes', 'The maximum photo size (bytes)', 500000, 100 * 1000 * 1000);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { hostname, port, photoRoot, autoStart, minFreeGb, operationTimeoutSeconds, maxPhotoBytes } };
}

function readConfigFile(filePath = configPath()) {
  try {
    return { exists: true, raw: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, raw: {} };
    return { exists: true, raw: {}, readError: `The settings file could not be read (${err.message}).` };
  }
}

function loadConfig(options = {}) {
  const file = readConfigFile(options.filePath);
  if (file.readError) return { ok: false, errors: [file.readError], notSetUp: false };
  const result = validateConfig(file.raw, options);
  if (!result.ok && !file.exists) return { ...result, notSetUp: true };
  return { ...result, notSetUp: false };
}

function saveConfig(raw, filePath = configPath()) {
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

module.exports = { DEFAULTS, HOSTNAME_PATTERN, validateConfig, loadConfig, saveConfig };

'use strict';

// Pairing for the photo-upload API: the one thing that stops any other
// device on the LAN from uploading just because it can reach this PC.
//
// Deliberately NOT a password typed on every visit - the operator reads a
// short, one-time code off this PC's own screen and types it into the iPad
// ONCE; the iPad is then issued a long-lived random token it keeps for
// every future upload (see delivery-photos-web/app.js). Nothing here adds a
// new listening port or changes the HTTPS/certificate arrangement at all -
// pairing is just two more routes on the server that already exists.
//
// Each paired iPad also has a photo ROLE - Delivery, Bench or Ironmongery
// (see photo-roles.js) - chosen on THIS PC when its pairing code is
// generated, stored here against its token, and never changeable from the
// iPad: verify() is the one place the server learns which role a request is
// allowed to act as. To change an iPad's role, remove it and pair it again.
// Records from before roles existed carry no role and are Delivery iPads
// (the only kind there was), so they keep working without re-pairing.
//
// What is stored, and where: only a per-device id, its role, a display name
// and a SHA-256 HASH of its token, in paths.js's devicesPath() (state/paired-devices.json, right next
// to status.json/worker.lock). The token itself is returned to the iPad
// exactly once, over the connection it just proved it can reach, and never
// written anywhere on this PC. A pairing CODE is even shorter-lived than
// that - kept only in memory, never persisted, because it only ever needs
// to survive the few minutes between being shown on screen and being typed
// into the iPad.

const fs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { isRole } = require('./photo-roles');

// No 0/O/1/I - unambiguous when read off a screen and typed on a phone/iPad
// keyboard. 8 characters from this 32-symbol alphabet is ~40 bits of
// entropy (over a trillion combinations) - combined with the short expiry
// and attempt limit below, not a realistic target for guessing.
const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 8;
const TOKEN_BYTES = 32;
const MAX_NAME_LENGTH = 40;
// A device record with no role at all predates roles: a Delivery iPad.
const LEGACY_ROLE = 'delivery';

// The operator-typed label shown in the device list ("iPad 2", "Bench
// left"). Display only - never used for a decision, a path or a log key.
function cleanName(name) {
  return String(name == null ? '' : name)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

function deviceRole(device) {
  if (device.role === undefined) return LEGACY_ROLE;
  return isRole(device.role) ? device.role : null; // anything else: a damaged record, which grants nothing
}

function randomPairingCode() {
  const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  return code;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// Both inputs are always-64-character hex SHA-256 digests here, so the
// length check never itself leaks anything about a real token's shape.
function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readDevices(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed.devices) ? parsed.devices : [];
  } catch {
    return [];
  }
}

function writeDevices(filePath, devices) {
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ devices }, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

// One instance lives for as long as the worker process does (see
// worker-entry.js). Devices (hashed tokens) persist to disk and survive a
// restart - an iPad stays paired. A pairing code does NOT persist - it is
// only ever useful in the few minutes right after "Pair a new iPad" is
// clicked, so a restart simply means any code in flight has to be
// re-issued, which is harmless and expected.
class PairingManager {
  constructor({ devicesPath, now = () => Date.now(), onChange = () => {} } = {}) {
    this.devicesPath = devicesPath;
    this.now = now;
    this.devices = readDevices(devicesPath);
    this.pending = null; // { code, role, name, expiresAt, attemptsLeft }
    this.onChange = onChange;
  }

  // Returns { code, expiresAt, role, name }. The code is tied to `role` (and
  // the optional display `name`): whichever iPad uses it becomes exactly
  // that, nothing the iPad sends can change it. Throws on an unknown role.
  // Generating a new code immediately invalidates any still-active one -
  // only ever one code live at a time.
  generateCode({ role, name } = {}) {
    if (!isRole(role)) throw new Error('Choose a photo role (Delivery, Bench or Ironmongery) before generating a pairing code.');
    const code = randomPairingCode();
    const label = cleanName(name) || `iPad ${this.devices.length + 1}`;
    this.pending = { code, role, name: label, expiresAt: this.now() + PAIRING_CODE_TTL_MS, attemptsLeft: PAIRING_MAX_ATTEMPTS };
    return { code, expiresAt: this.pending.expiresAt, role, name: label };
  }

  // Returns { ok: true, token, deviceId, role, name } or { ok: false, reason } where
  // reason is one of 'no_active_code' | 'expired' | 'too_many_attempts' | 'wrong_code'.
  pair(submittedCode) {
    if (!this.pending) return { ok: false, reason: 'no_active_code' };
    if (this.now() > this.pending.expiresAt) {
      this.pending = null;
      return { ok: false, reason: 'expired' };
    }
    if (this.pending.attemptsLeft <= 0) {
      this.pending = null;
      return { ok: false, reason: 'too_many_attempts' };
    }

    const normalized = String(submittedCode || '').trim().toUpperCase();
    if (normalized !== this.pending.code) {
      this.pending.attemptsLeft--;
      return { ok: false, reason: 'wrong_code' };
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const { role, name } = this.pending;
    const device = { id: crypto.randomUUID(), tokenHash: hashToken(token), role, name, pairedAt: new Date(this.now()).toISOString() };
    this.devices.push(device);
    writeDevices(this.devicesPath, this.devices);
    this.pending = null; // single-use, win or lose
    this.changed();
    return { ok: true, token, deviceId: device.id, role, name };
  }

  // Returns { ok: true, deviceId, role, name } or { ok: false }. The role is
  // the one stored with this token at pairing time - the only role the
  // server ever acts on for this device. Checks EVERY paired
  // device's hash (not just "the most recent") so more than one iPad can be
  // paired at once - a small workshop, small number of devices, so this
  // stays O(devices) rather than needing an index.
  verify(token) {
    if (typeof token !== 'string' || token.length < 32) return { ok: false };
    const presentedHash = hashToken(token);
    for (const device of this.devices) {
      if (!timingSafeEqualHex(presentedHash, device.tokenHash)) continue;
      const role = deviceRole(device);
      if (!role) return { ok: false };
      return { ok: true, deviceId: device.id, role, name: device.name || '' };
    }
    return { ok: false };
  }

  // Every paired device for the Windows app's list - never a token hash.
  listDevices() {
    return this.devices.map((device) => ({ id: device.id, name: device.name || '', role: deviceRole(device) || 'unknown', pairedAt: device.pairedAt || '' }));
  }

  // Un-pairs ONE iPad (e.g. to give it a different role: remove, then pair
  // again). Returns true if it was found. Its token stops working at once.
  revokeDevice(deviceId) {
    const remaining = this.devices.filter((device) => device.id !== deviceId);
    if (remaining.length === this.devices.length) return false;
    this.devices = remaining;
    writeDevices(this.devicesPath, this.devices);
    this.changed();
    return true;
  }

  // "Reset pairing" - every previously paired iPad must pair again. The
  // simplest reliable revoke for a small workshop: all-or-nothing, rather
  // than a per-device list to manage.
  revokeAll() {
    this.devices = [];
    writeDevices(this.devicesPath, this.devices);
    this.pending = null;
    this.changed();
  }

  changed() {
    try {
      this.onChange();
    } catch {
      // a status-display problem must never undo or fail a pairing change
    }
  }

  pairedCount() {
    return this.devices.length;
  }
}

module.exports = { PairingManager, hashToken, LEGACY_ROLE, PAIRING_CODE_TTL_MS, PAIRING_CODE_LENGTH };

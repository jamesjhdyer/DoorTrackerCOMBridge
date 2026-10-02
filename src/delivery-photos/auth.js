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
// What is stored, and where: only a per-device id and a SHA-256 HASH of its
// token, in paths.js's devicesPath() (state/paired-devices.json, right next
// to status.json/worker.lock). The token itself is returned to the iPad
// exactly once, over the connection it just proved it can reach, and never
// written anywhere on this PC. A pairing CODE is even shorter-lived than
// that - kept only in memory, never persisted, because it only ever needs
// to survive the few minutes between being shown on screen and being typed
// into the iPad.

const fs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');

// No 0/O/1/I - unambiguous when read off a screen and typed on a phone/iPad
// keyboard. 8 characters from this 32-symbol alphabet is ~40 bits of
// entropy (over a trillion combinations) - combined with the short expiry
// and attempt limit below, not a realistic target for guessing.
const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 8;
const TOKEN_BYTES = 32;

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
  constructor({ devicesPath, now = () => Date.now() } = {}) {
    this.devicesPath = devicesPath;
    this.now = now;
    this.devices = readDevices(devicesPath);
    this.pending = null; // { code, expiresAt, attemptsLeft }
  }

  // Returns { code, expiresAt }. Generating a new code immediately
  // invalidates any still-active one - only ever one code live at a time.
  generateCode() {
    const code = randomPairingCode();
    this.pending = { code, expiresAt: this.now() + PAIRING_CODE_TTL_MS, attemptsLeft: PAIRING_MAX_ATTEMPTS };
    return { code, expiresAt: this.pending.expiresAt };
  }

  // Returns { ok: true, token, deviceId } or { ok: false, reason } where
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
    const device = { id: crypto.randomUUID(), tokenHash: hashToken(token), pairedAt: new Date(this.now()).toISOString() };
    this.devices.push(device);
    writeDevices(this.devicesPath, this.devices);
    this.pending = null; // single-use, win or lose
    return { ok: true, token, deviceId: device.id };
  }

  // Returns { ok: true, deviceId } or { ok: false }. Checks EVERY paired
  // device's hash (not just "the most recent") so more than one iPad can be
  // paired at once - a small workshop, small number of devices, so this
  // stays O(devices) rather than needing an index.
  verify(token) {
    if (typeof token !== 'string' || token.length < 32) return { ok: false };
    const presentedHash = hashToken(token);
    for (const device of this.devices) {
      if (timingSafeEqualHex(presentedHash, device.tokenHash)) return { ok: true, deviceId: device.id };
    }
    return { ok: false };
  }

  // "Reset pairing" - every previously paired iPad must pair again. The
  // simplest reliable revoke for a small workshop: all-or-nothing, rather
  // than a per-device list to manage.
  revokeAll() {
    this.devices = [];
    writeDevices(this.devicesPath, this.devices);
    this.pending = null;
  }

  pairedCount() {
    return this.devices.length;
  }
}

module.exports = { PairingManager, hashToken, PAIRING_CODE_TTL_MS, PAIRING_CODE_LENGTH };

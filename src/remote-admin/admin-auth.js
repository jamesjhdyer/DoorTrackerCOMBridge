'use strict';

// Remote Admin's own sign-in: the admin password (set on THIS PC, in the
// Windows app's Remote Admin tab), the browser sessions a correct password
// creates, and the limits that make guessing it impractical.
//
// Deliberately separate from everything else that grants access anywhere in
// this app - an iPad's Delivery Photos pairing token is never consulted here
// and can never stand in for an admin session.
//
// What is stored: only a salted scrypt HASH of the password (see
// hashPassword), never the password itself. Sessions live only in the
// Remote Admin process's memory, keyed by a SHA-256 hash of the session
// token - restarting that process (or changing the password) signs every
// browser out.

const crypto = require('node:crypto');

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// scrypt cost: N=2^15, r=8, p=1 needs 32 MiB per hash and takes around a
// tenth of a second - unnoticeable for a sign-in, very expensive for anyone
// trying to guess from a stolen copy of the hash.
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 });

function validatePassword(password) {
  if (typeof password !== 'string') return { ok: false, error: 'Enter a password.' };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, error: `The admin password must be at least ${MIN_PASSWORD_LENGTH} characters (an 8-digit PIN is the shortest accepted).` };
  if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, error: `The admin password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  return { ok: true };
}

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// Returns the record to store: { scheme, N, r, p, keylen, salt, hash, setAt }.
async function hashPassword(password, { now = () => new Date() } = {}) {
  const check = validatePassword(password);
  if (!check.ok) throw new Error(check.error);
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return { scheme: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen, salt: salt.toString('base64'), hash: key.toString('base64'), setAt: now().toISOString() };
}

// True only for the right password against a well-formed record. A damaged
// or unrecognised record grants nothing.
async function verifyPassword(password, record) {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  if (!record || record.scheme !== 'scrypt') return false;
  const params = { N: Number(record.N), r: Number(record.r), p: Number(record.p), keylen: Number(record.keylen) };
  if (![params.N, params.r, params.p, params.keylen].every(Number.isInteger)) return false;
  if (params.N > SCRYPT.N * 4 || params.keylen < 16 || params.keylen > 64) return false;
  const expected = Buffer.from(String(record.hash || ''), 'base64');
  if (expected.length !== params.keylen) return false;
  let actual;
  try {
    actual = await scrypt(password, Buffer.from(String(record.salt || ''), 'base64'), params);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Signed-in browsers. A session ends after IDLE_MS without a request, or
// ABSOLUTE_MS after sign-in whatever happens, or on sign-out - whichever is
// first. Each session also carries its own CSRF token, which every
// state-changing request must echo back in a header (see admin-server.js).
class SessionStore {
  constructor({ idleMs = 30 * 60 * 1000, absoluteMs = 8 * 60 * 60 * 1000, maxSessions = 20, now = () => Date.now() } = {}) {
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    this.maxSessions = maxSessions;
    this.now = now;
    this.sessions = new Map(); // sha256(token) -> { csrfToken, ip, createdAt, lastSeenAt }
  }

  create(ip) {
    this.prune();
    while (this.sessions.size >= this.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value); // oldest first (Map keeps insertion order)
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const at = this.now();
    this.sessions.set(sha256Hex(token), { csrfToken, ip, createdAt: at, lastSeenAt: at });
    return { token, csrfToken, maxAgeSeconds: Math.floor(this.absoluteMs / 1000) };
  }

  // The live session for this token (touching its idle timer), or null.
  get(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const key = sha256Hex(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    const at = this.now();
    if (at - session.lastSeenAt > this.idleMs || at - session.createdAt > this.absoluteMs) {
      this.sessions.delete(key);
      return null;
    }
    session.lastSeenAt = at;
    return session;
  }

  destroy(token) {
    if (typeof token === 'string') this.sessions.delete(sha256Hex(token));
  }

  clear() {
    this.sessions.clear();
  }

  prune() {
    const at = this.now();
    for (const [key, session] of this.sessions) {
      if (at - session.lastSeenAt > this.idleMs || at - session.createdAt > this.absoluteMs) this.sessions.delete(key);
    }
  }

  get size() {
    this.prune();
    return this.sessions.size;
  }
}

// Failed sign-ins: at most MAX_PER_IP wrong passwords from one address in
// WINDOW_MS, and at most MAX_GLOBAL from everywhere put together (so moving
// between addresses on the LAN does not reset the count). Once over either
// limit, sign-in is refused WITHOUT checking the password at all until the
// oldest counted failure falls out of the window.
class LoginLimiter {
  constructor({ maxPerIp = 5, maxGlobal = 25, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxPerIp = maxPerIp;
    this.maxGlobal = maxGlobal;
    this.windowMs = windowMs;
    this.now = now;
    this.byIp = new Map(); // ip -> [failure times]
    this.global = [];
  }

  recent(times) {
    const cutoff = this.now() - this.windowMs;
    while (times.length > 0 && times[0] <= cutoff) times.shift();
    return times;
  }

  // { ok: true } or { ok: false, retryAfterSeconds }
  check(ip) {
    const mine = this.recent(this.byIp.get(ip) || []);
    const all = this.recent(this.global);
    const blockedUntil = [];
    if (mine.length >= this.maxPerIp) blockedUntil.push(mine[mine.length - this.maxPerIp] + this.windowMs);
    if (all.length >= this.maxGlobal) blockedUntil.push(all[all.length - this.maxGlobal] + this.windowMs);
    if (blockedUntil.length === 0) return { ok: true };
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((Math.max(...blockedUntil) - this.now()) / 1000)) };
  }

  recordFailure(ip) {
    const at = this.now();
    const mine = this.byIp.get(ip) || [];
    mine.push(at);
    this.byIp.set(ip, mine);
    this.global.push(at);
    if (this.byIp.size > 1000) this.byIp.delete(this.byIp.keys().next().value);
  }

  recordSuccess(ip) {
    this.byIp.delete(ip);
  }
}

// A plain ceiling on how many requests one address may make per minute -
// far above what the admin page itself ever sends, low enough that nothing
// on the LAN can keep this process busy.
class RequestLimiter {
  constructor({ limit = 240, windowMs = 60 * 1000, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.windows = new Map(); // ip -> { start, count }
  }

  allow(ip) {
    const at = this.now();
    let entry = this.windows.get(ip);
    if (!entry || at - entry.start >= this.windowMs) {
      if (this.windows.size > 1000) this.windows.clear();
      entry = { start: at, count: 0 };
      this.windows.set(ip, entry);
    }
    entry.count++;
    return entry.count <= this.limit;
  }
}

module.exports = { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, SCRYPT, validatePassword, hashPassword, verifyPassword, SessionStore, LoginLimiter, RequestLimiter };

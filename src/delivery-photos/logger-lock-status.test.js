'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

const { createLogger } = require('./logger');
const { acquireLock, defaultIsAlive } = require('./lock');
const { createStatusFile, readStatus, describeStatus } = require('./status');
const { makeEnv } = require('./helpers');

// ---- logger -----------------------------------------------------------

test('the logger writes a dated file and redacts secrets and paths', () => {
  const env = makeEnv();
  try {
    const dir = nodePath.join(env.home, 'logs');
    const secret = require('node:crypto').randomBytes(24).toString('base64url'); // stands in for any secret value worth redacting
    const logger = createLogger({ dir, secrets: [secret], roots: [env.share], now: () => new Date('2026-01-15T10:00:00Z') });
    logger.info(`internal detail containing ${secret}`);
    logger.error(`could not read ${nodePath.join(env.share, '5698-DELIV', 'photo-001.jpg')}`);

    const file = nodePath.join(dir, 'delivery-photos-2026-01-15.log');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(secret), 'the secret must never appear in the log');
    assert.ok(text.includes('***'));
    assert.ok(!text.includes(env.share), 'the real archive path must never appear in the log');
    assert.ok(text.includes('<archive>'));
    assert.match(text, /INFO /);
    assert.match(text, /ERROR/);
  } finally {
    env.cleanup();
  }
});

test('old log files are pruned, recent ones are kept', () => {
  const env = makeEnv();
  try {
    const dir = nodePath.join(env.home, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const old = nodePath.join(dir, 'delivery-photos-2000-01-01.log');
    fs.writeFileSync(old, 'ancient\n');
    fs.utimesSync(old, new Date('2000-01-01'), new Date('2000-01-01'));
    const recent = nodePath.join(dir, 'delivery-photos-2026-01-14.log');
    fs.writeFileSync(recent, 'yesterday\n');

    createLogger({ dir, now: () => new Date('2026-01-15T10:00:00Z') }).info('housekeeping ran');

    assert.ok(!fs.existsSync(old), 'a log older than the retention window must be removed');
    assert.ok(fs.existsSync(recent), 'a recent log must be kept');
  } finally {
    env.cleanup();
  }
});

test('a logger with no writable folder falls back to the console instead of crashing', () => {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    const logger = createLogger({ dir: '' });
    logger.info('hello');
    assert.ok(lines.some((l) => l.includes('hello')));
  } finally {
    console.log = original;
  }
});

// ---- lock ---------------------------------------------------------------

test('only one Delivery Photos worker can hold the lock at a time', () => {
  const env = makeEnv();
  try {
    const lockPath = nodePath.join(env.home, 'state', 'bridge.lock');
    const first = acquireLock(lockPath, { pid: 111, isAlive: () => true });
    assert.equal(first.ok, true);
    const second = acquireLock(lockPath, { pid: 222, isAlive: () => true });
    assert.equal(second.ok, false);
    assert.equal(second.pid, 111);
  } finally {
    env.cleanup();
  }
});

test('a lock left by a process that no longer exists is taken over', () => {
  const env = makeEnv();
  try {
    const lockPath = nodePath.join(env.home, 'state', 'bridge.lock');
    acquireLock(lockPath, { pid: 111, isAlive: () => false });
    const second = acquireLock(lockPath, { pid: 222, isAlive: () => false });
    assert.equal(second.ok, true);
  } finally {
    env.cleanup();
  }
});

test('a lock that has gone quiet for a long time is taken over even if the pid still exists (Windows recycled it)', () => {
  const env = makeEnv();
  try {
    const lockPath = nodePath.join(env.home, 'state', 'bridge.lock');
    acquireLock(lockPath, { pid: 111, isAlive: () => true });
    // Staleness is judged from the lock file's real mtime, so back-date that directly
    // rather than an injected clock (which readLock does not use).
    const old = new Date(Date.now() - 3600000);
    fs.utimesSync(lockPath, old, old);
    const second = acquireLock(lockPath, { pid: 222, isAlive: () => true, staleMs: 5000 });
    assert.equal(second.ok, true);
  } finally {
    env.cleanup();
  }
});

test('release only removes a lock this process actually holds', () => {
  const env = makeEnv();
  try {
    const lockPath = nodePath.join(env.home, 'state', 'bridge.lock');
    const first = acquireLock(lockPath, { pid: 111, isAlive: () => true });
    // Someone else takes it over (simulating a stale takeover) before we release.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999 }));
    first.release();
    assert.ok(fs.existsSync(lockPath), 'must not remove a lock now held by someone else');
  } finally {
    env.cleanup();
  }
});

test('defaultIsAlive recognises the current process as alive', () => {
  assert.equal(defaultIsAlive(process.pid), true);
});

// ---- status ---------------------------------------------------------------

test('the status file is written atomically and can be read back', () => {
  const env = makeEnv();
  try {
    const filePath = nodePath.join(env.home, 'state', 'status.json');
    const status = createStatusFile(filePath, {}, () => new Date('2026-01-15T10:00:00Z'));
    status.write({ state: 'idle', pid: process.pid });
    const read = readStatus(filePath);
    assert.equal(read.state, 'idle');
    assert.equal(read.pid, process.pid);
    assert.deepEqual(fs.readdirSync(nodePath.dirname(filePath)), ['status.json'], 'no temp file left behind');
  } finally {
    env.cleanup();
  }
});

test('reading a missing or damaged status file returns null, not a crash', () => {
  const env = makeEnv();
  try {
    assert.equal(readStatus(nodePath.join(env.home, 'nope.json')), null);
    const bad = nodePath.join(env.home, 'bad.json');
    fs.writeFileSync(bad, 'not json');
    assert.equal(readStatus(bad), null);
  } finally {
    env.cleanup();
  }
});

test('describeStatus says RUNNING only when the process exists and reported recently', () => {
  const nowMs = Date.parse('2026-01-15T10:00:00Z');
  const fresh = { pid: 123, state: 'idle', updatedAt: '2026-01-15T09:59:50Z', pollSeconds: 15, version: '0.2.0', startedAt: '2026-01-15T09:00:00Z' };
  const running = describeStatus(fresh, { nowMs, isAlive: () => true });
  assert.equal(running.running, true);
  assert.match(running.lines[0], /RUNNING/);

  const goneQuiet = describeStatus({ ...fresh, updatedAt: '2026-01-15T09:00:00Z' }, { nowMs, isAlive: () => true });
  assert.equal(goneQuiet.running, false, 'stale heartbeat must not be reported as running');

  const processGone = describeStatus(fresh, { nowMs, isAlive: () => false });
  assert.equal(processGone.running, false);

  const stopped = describeStatus({ ...fresh, state: 'stopped' }, { nowMs, isAlive: () => true });
  assert.equal(stopped.running, false);
  assert.match(stopped.lines[0], /NOT RUNNING/);

  const never = describeStatus(null, { nowMs });
  assert.equal(never.running, false);
  assert.match(never.lines[0], /never run/);
});

test('describeStatus mentions the network folder, counts, and the last problem', () => {
  const nowMs = Date.parse('2026-01-15T10:00:00Z');
  const status = {
    pid: process.pid, state: 'idle', updatedAt: '2026-01-15T09:59:55Z', lastPollAt: '2026-01-15T09:59:55Z', lastPollOk: true,
    shareOk: true, freeGb: '512.3', filed: 7, failed: 1, lastError: 'Low disk space on the network folder (1.0 GB free, minimum 2 GB).'
  };
  const { lines } = describeStatus(status, { nowMs, isAlive: () => true });
  const text = lines.join('\n');
  assert.match(text, /512\.3 GB free/);
  assert.match(text, /filed since it started: 7/);
  assert.match(text, /failed attempts: 1/);
  assert.match(text, /Low disk space/);
});

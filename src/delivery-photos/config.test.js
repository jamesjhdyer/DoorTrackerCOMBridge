'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const { validateConfig, loadConfig, saveConfig, DEFAULTS } = require('./config');

const WIN = { platform: 'win32' };
const UNC = '\\\\FILESERVER\\Shared\\Delivery Photographs';
const good = () => ({ hostname: 'door-tracker.local', photoRoot: UNC });

function scratch() {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dp-config-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test('a complete, correct set of settings is accepted and defaults are filled in', () => {
  const result = validateConfig(good(), WIN);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.config.hostname, 'door-tracker.local');
  assert.equal(result.config.port, DEFAULTS.port);
  assert.equal(result.config.autoStart, true);
});

test('the hostname must be a single label ending in .local', () => {
  for (const bad of ['', 'door-tracker', 'door tracker.local', 'door_tracker.local', 'http://door-tracker.local', '-door.local', 'door-.local', 'a.b.local']) {
    assert.equal(validateConfig({ ...good(), hostname: bad }, WIN).ok, false, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(validateConfig({ ...good(), hostname: 'DOOR-TRACKER.LOCAL' }, WIN).config.hostname, 'door-tracker.local', 'lower-cased');
});

test('the port must be a sensible whole number', () => {
  for (const bad of [0, 80, 1023, 65536, 1.5, 'abc', -1]) {
    assert.equal(validateConfig({ ...good(), port: bad }, WIN).ok, false, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(validateConfig({ ...good(), port: '9443' }, WIN).config.port, 9443);
});

test('the archive folder must be a network path; drive letters refused without the test switch', () => {
  for (const bad of ['', 'S:\\Photos', 'relative\\path', '/etc']) {
    assert.equal(validateConfig({ ...good(), photoRoot: bad }, WIN).ok, false, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(validateConfig({ ...good(), photoRoot: 'S:\\Photos' }, { ...WIN, allowDriveLetter: true }).ok, true);
});

// Every case named explicitly, individually, rather than trusting one example
// to stand in for the rest - this is the rule that must never weaken: a real
// delivery archive is never, ever a drive letter, on real Windows, in production.
test('production Windows path rules exactly: UNC allowed, every drive letter rejected, relative rejected', () => {
  assert.equal(validateConfig({ ...good(), photoRoot: '\\\\SERVER\\Share\\Delivery Photographs' }, WIN).ok, true, 'UNC path must be allowed');
  for (const drive of ['S:\\Photos', 'Z:\\Photos', 'C:\\Photos', 'D:\\Photos']) {
    const result = validateConfig({ ...good(), photoRoot: drive }, WIN);
    assert.equal(result.ok, false, `${drive} must be rejected`);
    assert.ok(result.errors.some((e) => /drive letter/.test(e)), `${drive} must be rejected specifically as a drive letter, not some other reason: ${result.errors}`);
  }
  assert.equal(validateConfig({ ...good(), photoRoot: 'relative\\path\\to\\photos' }, WIN).ok, false, 'a relative path must be rejected');
});

test('every problem is reported at once, in plain language', () => {
  const result = validateConfig({ hostname: '', photoRoot: '', port: -1 }, WIN);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
  for (const message of result.errors) assert.match(message, /^[A-Z]/);
});

test('numbers outside their range are refused, others fill in from defaults', () => {
  assert.equal(validateConfig({ ...good(), minFreeGb: -1 }, WIN).ok, false);
  assert.equal(validateConfig({ ...good(), operationTimeoutSeconds: 5 }, WIN).ok, false);
  assert.equal(validateConfig({ ...good(), maxPhotoBytes: 10 }, WIN).ok, false);
  assert.equal(validateConfig(good(), WIN).config.maxPhotoBytes, DEFAULTS.maxPhotoBytes);
});

test('a missing settings file means "not set up yet", not a crash', () => {
  const s = scratch();
  try {
    const result = loadConfig({ ...WIN, filePath: nodePath.join(s.dir, 'config.json') });
    assert.equal(result.ok, false);
    assert.equal(result.notSetUp, true);
  } finally {
    s.cleanup();
  }
});

test('settings survive a save and load; a damaged file is reported, not crashed on', () => {
  const s = scratch();
  try {
    const filePath = nodePath.join(s.dir, 'config.json');
    saveConfig(good(), filePath);
    const loaded = loadConfig({ ...WIN, filePath });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.config.hostname, 'door-tracker.local');
    assert.deepEqual(fs.readdirSync(s.dir), ['config.json'], 'no temp file left behind');

    fs.writeFileSync(filePath, '{ not json');
    const damaged = loadConfig({ ...WIN, filePath });
    assert.equal(damaged.ok, false);
    assert.equal(damaged.notSetUp, false);
  } finally {
    s.cleanup();
  }
});

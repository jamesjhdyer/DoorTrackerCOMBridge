'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

const { PairingManager } = require('./auth');
const { makeEnv } = require('./helpers');

function manager(env, extra = {}) {
  return new PairingManager({ devicesPath: nodePath.join(env.home, 'paired-devices.json'), ...extra });
}

test('a device with no pairing code active is refused, nothing is paired', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const result = m.pair('ANYCODE1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_active_code');
    assert.equal(m.pairedCount(), 0);
  } finally {
    env.cleanup();
  }
});

test('the right code issues a token, and that token verifies', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const { code } = m.generateCode();
    const result = m.pair(code);
    assert.equal(result.ok, true);
    assert.ok(result.token && result.token.length >= 32);
    assert.ok(result.deviceId);
    assert.equal(m.pairedCount(), 1);

    const verified = m.verify(result.token);
    assert.equal(verified.ok, true);
    assert.equal(verified.deviceId, result.deviceId);
  } finally {
    env.cleanup();
  }
});

test('pairing is case-insensitive and trims whitespace, since a person is typing it', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const { code } = m.generateCode();
    const result = m.pair(`  ${code.toLowerCase()}  `);
    assert.equal(result.ok, true);
  } finally {
    env.cleanup();
  }
});

test('a wrong code is refused and does not consume the real one', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const { code } = m.generateCode();
    const wrong = m.pair('WRONGCOD');
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'wrong_code');

    const right = m.pair(code);
    assert.equal(right.ok, true, 'the real code must still work after a wrong attempt');
  } finally {
    env.cleanup();
  }
});

test('a code can only be used once - pairing a second device needs a new code', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const { code } = m.generateCode();
    assert.equal(m.pair(code).ok, true);
    const second = m.pair(code);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'no_active_code');
    assert.equal(m.pairedCount(), 1);
  } finally {
    env.cleanup();
  }
});

test('generating a new code invalidates whatever code was active before', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const first = m.generateCode();
    m.generateCode(); // a second code, before the first was ever used
    const result = m.pair(first.code);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'wrong_code');
  } finally {
    env.cleanup();
  }
});

test('a code expires after its TTL', () => {
  const env = makeEnv();
  try {
    let now = 1000000;
    const m = manager(env, { now: () => now });
    const { code } = m.generateCode();
    now += 11 * 60 * 1000; // 11 minutes later - past the 10 minute TTL
    const result = m.pair(code);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
  } finally {
    env.cleanup();
  }
});

test('too many wrong attempts invalidates the code even before it expires', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const { code } = m.generateCode();
    for (let i = 0; i < 8; i++) assert.equal(m.pair('WRONGCOD').ok, false);
    const result = m.pair(code); // the real code, tried after the attempt budget is spent
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'too_many_attempts');
  } finally {
    env.cleanup();
  }
});

test('verify refuses an unknown token, an empty token, and a short/garbage value without throwing', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const { code } = m.generateCode();
    m.pair(code);
    for (const bad of ['', 'short', 'a'.repeat(64), undefined, null, 42]) {
      assert.equal(m.verify(bad).ok, false, JSON.stringify(bad));
    }
  } finally {
    env.cleanup();
  }
});

test('more than one device can be paired at once, and each other devices token still verifies', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const a = m.pair(m.generateCode().code);
    const b = m.pair(m.generateCode().code);
    assert.notEqual(a.deviceId, b.deviceId);
    assert.equal(m.verify(a.token).ok, true);
    assert.equal(m.verify(b.token).ok, true);
    assert.equal(m.pairedCount(), 2);
  } finally {
    env.cleanup();
  }
});

test('revokeAll un-pairs every device at once, and clears any in-flight code', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const paired = m.pair(m.generateCode().code);
    const activeCode = m.generateCode();
    m.revokeAll();
    assert.equal(m.pairedCount(), 0);
    assert.equal(m.verify(paired.token).ok, false, 'the old token must no longer verify');
    assert.equal(m.pair(activeCode.code).ok, false, 'the in-flight code must also be cleared');
  } finally {
    env.cleanup();
  }
});

test('paired devices (hashed tokens only) survive a restart - a new PairingManager over the same file sees them', () => {
  const env = makeEnv();
  try {
    const devicesPath = nodePath.join(env.home, 'paired-devices.json');
    const first = new PairingManager({ devicesPath });
    const paired = first.pair(first.generateCode().code);

    const second = new PairingManager({ devicesPath });
    assert.equal(second.pairedCount(), 1);
    assert.equal(second.verify(paired.token).ok, true);
  } finally {
    env.cleanup();
  }
});

test('the token itself is never written to disk - only a SHA-256 hash of it', () => {
  const env = makeEnv();
  try {
    const devicesPath = nodePath.join(env.home, 'paired-devices.json');
    const m = new PairingManager({ devicesPath });
    const { token } = m.pair(m.generateCode().code);

    const onDisk = fs.readFileSync(devicesPath, 'utf8');
    assert.ok(!onDisk.includes(token), 'the raw token must never appear in the persisted file');
    assert.match(onDisk, /"tokenHash": ?"[0-9a-f]{64}"/, 'a 64-char hex SHA-256 hash must be stored instead');
  } finally {
    env.cleanup();
  }
});

test('a pairing code only ever contains unambiguous characters (no 0/O/1/I)', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    for (let i = 0; i < 20; i++) {
      const { code } = m.generateCode();
      assert.equal(code.length, 8);
      assert.doesNotMatch(code, /[01OI]/);
    }
  } finally {
    env.cleanup();
  }
});

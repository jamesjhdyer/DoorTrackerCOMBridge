'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

const { PairingManager, hashToken } = require('./auth');
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
    const { code } = m.generateCode({ role: 'delivery' });
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
    const { code } = m.generateCode({ role: 'delivery' });
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
    const { code } = m.generateCode({ role: 'delivery' });
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
    const { code } = m.generateCode({ role: 'delivery' });
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
    const first = m.generateCode({ role: 'delivery' });
    m.generateCode({ role: 'delivery' }); // a second code, before the first was ever used
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
    const { code } = m.generateCode({ role: 'delivery' });
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
    const { code } = m.generateCode({ role: 'delivery' });
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
    const { code } = m.generateCode({ role: 'delivery' });
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
    const a = m.pair(m.generateCode({ role: 'delivery' }).code);
    const b = m.pair(m.generateCode({ role: 'delivery' }).code);
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
    const paired = m.pair(m.generateCode({ role: 'delivery' }).code);
    const activeCode = m.generateCode({ role: 'delivery' });
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
    const paired = first.pair(first.generateCode({ role: 'delivery' }).code);

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
    const { token } = m.pair(m.generateCode({ role: 'delivery' }).code);

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
      const { code } = m.generateCode({ role: 'delivery' });
      assert.equal(code.length, 8);
      assert.doesNotMatch(code, /[01OI]/);
    }
  } finally {
    env.cleanup();
  }
});

// ---- Photo roles ----

test('each role pairs as exactly that role: Delivery, Bench and Ironmongery tokens', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    for (const role of ['delivery', 'bench', 'ironmongery']) {
      const paired = m.pair(m.generateCode({ role }).code);
      assert.equal(paired.role, role);
      assert.equal(m.verify(paired.token).role, role, `a ${role} token verifies as ${role}`);
    }
    assert.deepEqual(m.listDevices().map((d) => d.role), ['delivery', 'bench', 'ironmongery']);
  } finally {
    env.cleanup();
  }
});

test('a pairing code cannot be generated without a valid role', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    for (const bad of [{}, { role: '' }, { role: 'admin' }, { role: 'DELIVERY' }, { role: '__proto__' }, undefined]) {
      assert.throws(() => m.generateCode(bad), /photo role/);
    }
    assert.equal(m.pair('ANYCODE1').reason, 'no_active_code');
  } finally {
    env.cleanup();
  }
});

test('the iPad cannot choose or change its role: whatever it sends with the code, the PC-side role wins', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    const { code } = m.generateCode({ role: 'bench' });
    // pair() takes the code alone - there is no way to hand it a role at all.
    const paired = m.pair(code, { role: 'delivery' });
    assert.equal(paired.role, 'bench');
    assert.equal(m.verify(paired.token).role, 'bench');
  } finally {
    env.cleanup();
  }
});

test('role and name persist across a restart; the token is still never stored', () => {
  const env = makeEnv();
  try {
    const devicesPath = nodePath.join(env.home, 'paired-devices.json');
    const first = new PairingManager({ devicesPath });
    const bench = first.pair(first.generateCode({ role: 'bench', name: 'Bench left' }).code);
    const irn = first.pair(first.generateCode({ role: 'ironmongery' }).code);

    const second = new PairingManager({ devicesPath });
    assert.deepEqual([second.verify(bench.token).role, second.verify(bench.token).name], ['bench', 'Bench left']);
    assert.deepEqual([second.verify(irn.token).role, second.verify(irn.token).name], ['ironmongery', 'iPad 2']);
    const onDisk = fs.readFileSync(devicesPath, 'utf8');
    assert.ok(!onDisk.includes(bench.token) && !onDisk.includes(irn.token));
  } finally {
    env.cleanup();
  }
});

test('a device paired before roles existed (no role on record) keeps working as Delivery', () => {
  const env = makeEnv();
  try {
    const devicesPath = nodePath.join(env.home, 'paired-devices.json');
    const token = 'b'.repeat(64);
    fs.writeFileSync(devicesPath, JSON.stringify({ devices: [{ id: 'legacy-1', tokenHash: hashToken(token), pairedAt: '2026-09-01T10:00:00.000Z' }] }));
    const m = new PairingManager({ devicesPath });
    assert.deepEqual(m.verify(token), { ok: true, deviceId: 'legacy-1', role: 'delivery', name: '' });
    assert.equal(m.listDevices()[0].role, 'delivery');
  } finally {
    env.cleanup();
  }
});

test('a device record with a damaged/unknown role grants nothing', () => {
  const env = makeEnv();
  try {
    const devicesPath = nodePath.join(env.home, 'paired-devices.json');
    const token = 'c'.repeat(64);
    fs.writeFileSync(devicesPath, JSON.stringify({ devices: [{ id: 'odd', tokenHash: hashToken(token), role: 'superuser' }] }));
    assert.equal(new PairingManager({ devicesPath }).verify(token).ok, false);
  } finally {
    env.cleanup();
  }
});

test('display names are cleaned and capped, and default to "iPad N"', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    assert.equal(m.generateCode({ role: 'bench', name: '  Bench\u0000 left\n ' }).name, 'Bench left');
    assert.equal(m.generateCode({ role: 'bench', name: 'x'.repeat(100) }).name.length, 40);
    assert.equal(m.generateCode({ role: 'bench', name: '   ' }).name, 'iPad 1');
  } finally {
    env.cleanup();
  }
});

test('revoking ONE device stops only its token; revokeAll still un-pairs everyone', () => {
  const env = makeEnv();
  try {
    const changes = [];
    const m = manager(env, { onChange: () => changes.push(m.pairedCount()) });
    const a = m.pair(m.generateCode({ role: 'delivery' }).code);
    const b = m.pair(m.generateCode({ role: 'bench' }).code);
    assert.equal(m.revokeDevice(b.deviceId), true);
    assert.equal(m.verify(b.token).ok, false);
    assert.equal(m.verify(a.token).ok, true);
    assert.equal(m.revokeDevice(b.deviceId), false, 'already gone');
    assert.equal(m.revokeDevice('no-such-id'), false);

    // Re-pairing the same iPad with a different role: a new code, a new token, the new role.
    const again = m.pair(m.generateCode({ role: 'delivery' }).code);
    assert.equal(m.verify(again.token).role, 'delivery');

    m.revokeAll();
    assert.equal(m.verify(a.token).ok, false);
    assert.equal(m.verify(again.token).ok, false);
    assert.deepEqual(changes, [1, 2, 1, 2, 0], 'every pairing change is reported for the status panel');
  } finally {
    env.cleanup();
  }
});

test('listDevices never exposes a token hash', () => {
  const env = makeEnv();
  try {
    const m = manager(env);
    m.pair(m.generateCode({ role: 'ironmongery', name: 'Stores' }).code);
    const [device] = m.listDevices();
    assert.deepEqual(Object.keys(device).sort(), ['id', 'name', 'pairedAt', 'role']);
    assert.deepEqual([device.role, device.name], ['ironmongery', 'Stores']);
  } finally {
    env.cleanup();
  }
});

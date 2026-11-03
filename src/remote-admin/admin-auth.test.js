'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validatePassword, hashPassword, verifyPassword, SessionStore, LoginLimiter, RequestLimiter } = require('./admin-auth');

test('only a salted scrypt hash is produced - never the password - and it verifies correctly', async () => {
  const record = await hashPassword('correct horse 42');
  assert.equal(record.scheme, 'scrypt');
  assert.ok(!JSON.stringify(record).includes('correct horse 42'));
  assert.equal(await verifyPassword('correct horse 42', record), true);
  assert.equal(await verifyPassword('correct horse 43', record), false);
  assert.equal(await verifyPassword('', record), false);

  const again = await hashPassword('correct horse 42');
  assert.notEqual(again.salt, record.salt, 'a fresh salt every time');
  assert.notEqual(again.hash, record.hash);
});

test('a damaged or foreign password record grants nothing', async () => {
  const record = await hashPassword('12345678');
  assert.equal(await verifyPassword('12345678', null), false);
  assert.equal(await verifyPassword('12345678', { ...record, scheme: 'plain' }), false);
  assert.equal(await verifyPassword('12345678', { ...record, hash: 'AAAA' }), false);
  assert.equal(await verifyPassword('12345678', { ...record, N: 'lots' }), false);
  assert.equal(await verifyPassword('12345678', { ...record, N: 2 ** 30 }), false, 'refuses absurd cost parameters');
});

test('password policy: 8 to 128 characters', async () => {
  assert.equal(validatePassword('1234567').ok, false);
  assert.equal(validatePassword('12345678').ok, true);
  assert.equal(validatePassword('x'.repeat(129)).ok, false);
  assert.equal(validatePassword(undefined).ok, false);
  await assert.rejects(hashPassword('short'));
});

test('sessions expire after the idle timeout and after the absolute limit, and can be destroyed', () => {
  let now = 1_000_000;
  const store = new SessionStore({ idleMs: 1000, absoluteMs: 5000, now: () => now });

  const a = store.create('10.0.0.1');
  assert.ok(store.get(a.token));
  now += 999;
  assert.ok(store.get(a.token), 'still inside the idle window');
  now += 1001;
  assert.equal(store.get(a.token), null, 'idle too long');

  const b = store.create('10.0.0.1');
  for (let i = 0; i < 5; i++) {
    now += 900;
    store.get(b.token);
  }
  now += 900;
  assert.equal(store.get(b.token), null, 'absolute limit reached even though it was kept busy');

  const c = store.create('10.0.0.1');
  store.destroy(c.token);
  assert.equal(store.get(c.token), null);
  assert.equal(store.get('not-a-real-token-but-long-enough'), null);
});

test('sessions are stored only as hashes and each has its own CSRF token', () => {
  const store = new SessionStore();
  const a = store.create('10.0.0.1');
  const b = store.create('10.0.0.2');
  assert.notEqual(a.csrfToken, b.csrfToken);
  assert.ok(![...store.sessions.keys()].includes(a.token));
  assert.equal(store.get(a.token).csrfToken, a.csrfToken);
});

test('login limiter: blocks one address after 5 failures, and everyone after 25, until the window passes', () => {
  let now = 0;
  const limiter = new LoginLimiter({ maxPerIp: 5, maxGlobal: 25, windowMs: 60000, now: () => now });
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.check('10.0.0.1').ok, true);
    limiter.recordFailure('10.0.0.1');
  }
  const blocked = limiter.check('10.0.0.1');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);
  assert.equal(limiter.check('10.0.0.2').ok, true, 'another address is not blocked by one address alone');

  now += 60001;
  assert.equal(limiter.check('10.0.0.1').ok, true, 'unblocked once the window passes');

  for (let i = 0; i < 25; i++) limiter.recordFailure(`10.0.1.${i}`);
  assert.equal(limiter.check('10.0.2.1').ok, false, 'spreading guesses across addresses does not help');
});

test('a successful sign-in clears that address\'s failures', () => {
  const limiter = new LoginLimiter({ maxPerIp: 3 });
  limiter.recordFailure('10.0.0.1');
  limiter.recordFailure('10.0.0.1');
  limiter.recordSuccess('10.0.0.1');
  limiter.recordFailure('10.0.0.1');
  limiter.recordFailure('10.0.0.1');
  assert.equal(limiter.check('10.0.0.1').ok, true);
});

test('request limiter caps requests per address per window', () => {
  let now = 0;
  const limiter = new RequestLimiter({ limit: 3, windowMs: 1000, now: () => now });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.allow('10.0.0.1')), [true, true, true, false]);
  assert.equal(limiter.allow('10.0.0.2'), true);
  now += 1000;
  assert.equal(limiter.allow('10.0.0.1'), true);
});

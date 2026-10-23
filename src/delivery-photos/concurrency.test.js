'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ConcurrencyLimiter } = require('./concurrency');

test('up to maxConcurrent operations are admitted immediately', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 3, maxQueue: 0, maxWaitMs: 1000 });
  const slots = await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  for (const slot of slots) assert.equal(slot.ok, true);
  assert.equal(limiter.snapshot().active, 3);
});

test('an operation beyond the limit, with no queue room, is rejected immediately (not after waiting)', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 0, maxWaitMs: 5000 });
  const first = await limiter.acquire();
  assert.equal(first.ok, true);

  const start = Date.now();
  const second = await limiter.acquire();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'queue_full');
  assert.ok(Date.now() - start < 200, 'must be rejected immediately, not after the wait timeout');
});

test('a queued request is admitted as soon as a slot frees up, well before its wait timeout', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 2, maxWaitMs: 5000 });
  const first = await limiter.acquire();
  assert.equal(first.ok, true);

  const queued = limiter.acquire(); // must wait - no free slot
  await new Promise((r) => setTimeout(r, 50));
  first.release();

  const result = await queued;
  assert.equal(result.ok, true, 'the queued caller must be admitted once the slot frees up');
});

test('a queued request that waits too long is rejected cleanly with a retryable reason', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 2, maxWaitMs: 100 });
  const first = await limiter.acquire(); // never released during this test
  const queued = await limiter.acquire();
  assert.equal(queued.ok, false);
  assert.equal(queued.reason, 'timeout');
  void first;
});

test('the queue itself has a bound - once full, further requests are rejected rather than queued indefinitely', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1, maxWaitMs: 5000 });
  const first = await limiter.acquire();
  assert.equal(first.ok, true);

  const queuedOk = limiter.acquire(); // fills the one queue slot
  await new Promise((r) => setTimeout(r, 10)); // let it actually enqueue
  const overflow = await limiter.acquire(); // queue is now full
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'queue_full');

  first.release();
  assert.equal((await queuedOk).ok, true);
});

test('releasing a slot hands it to the longest-waiting queued caller, in order', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 5, maxWaitMs: 5000 });
  const first = await limiter.acquire();
  const order = [];
  const second = limiter.acquire().then((s) => { order.push('second'); return s; });
  await new Promise((r) => setTimeout(r, 10));
  const third = limiter.acquire().then((s) => { order.push('third'); return s; });
  await new Promise((r) => setTimeout(r, 10));

  first.release();
  const secondSlot = await second;
  assert.deepEqual(order, ['second']);
  secondSlot.release();
  await third;
  assert.deepEqual(order, ['second', 'third']);
});

test('many operations can run at once without ever exceeding maxConcurrent', async () => {
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 4, maxQueue: 20, maxWaitMs: 5000 });
  let peak = 0;
  let current = 0;

  async function run() {
    const slot = await limiter.acquire();
    if (!slot.ok) return;
    current++;
    peak = Math.max(peak, current);
    await new Promise((r) => setTimeout(r, 20));
    current--;
    slot.release();
  }

  await Promise.all(Array.from({ length: 20 }, () => run()));
  assert.ok(peak <= 4, `peak concurrency ${peak} must never exceed the limit`);
});

// ---- KeyedMutex: one archive operation per order folder at a time ----

const { KeyedMutex } = require('./concurrency');
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('KeyedMutex runs same-key work strictly one after another, in arrival order', async () => {
  const mutex = new KeyedMutex();
  const events = [];
  const job = (name, ms) => mutex.run('5698', async () => {
    events.push(`start ${name}`);
    await tick(ms);
    events.push(`end ${name}`);
    return name;
  });
  const results = await Promise.all([job('a', 30), job('b', 5), job('c', 1)]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.equal(mutex.size(), 0, 'keys are forgotten once idle');
});

test('KeyedMutex lets different keys run side by side', async () => {
  const mutex = new KeyedMutex();
  let concurrent = 0;
  let peak = 0;
  const job = (key) => mutex.run(key, async () => {
    peak = Math.max(peak, ++concurrent);
    await tick(20);
    concurrent--;
  });
  await Promise.all([job('5698'), job('5626-2'), job('5701')]);
  assert.equal(peak, 3);
});

test('KeyedMutex: a failure is passed to its own caller and never blocks the next run', async () => {
  const mutex = new KeyedMutex();
  const failing = mutex.run('5698', async () => {
    throw new Error('drive went away');
  });
  const next = mutex.run('5698', async () => 'still runs');
  await assert.rejects(failing, /drive went away/);
  assert.equal(await next, 'still runs');
});

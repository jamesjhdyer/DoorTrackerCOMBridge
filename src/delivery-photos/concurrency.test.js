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

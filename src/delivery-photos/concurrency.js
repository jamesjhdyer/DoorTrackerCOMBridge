'use strict';

// A global cap on how many photo-processing operations (each one a forked
// worker process - see worker-runner.js) may run at once, so an unbounded
// flood of requests can never fork an unbounded number of processes. This
// does not touch the per-operation hard timeout/isolation design at all -
// it only decides WHEN an operation is allowed to start.
//
// A normal delivery (one iPad, uploading its own photos one at a time - see
// delivery-photos-web/app.js's uploadPending()) only ever needs one slot.
// The limit exists for several iPads overlapping, or a device sending many
// requests at once.

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_QUEUE = 8;
const DEFAULT_MAX_WAIT_MS = 5000;

class ConcurrencyLimiter {
  constructor({ maxConcurrent = DEFAULT_MAX_CONCURRENT, maxQueue = DEFAULT_MAX_QUEUE, maxWaitMs = DEFAULT_MAX_WAIT_MS } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.maxWaitMs = maxWaitMs;
    this.active = 0;
    this.queue = [];
  }

  // Returns { ok: true, release() } immediately if a slot is free, or if one
  // frees up within maxWaitMs of waiting in a small bounded queue - this is
  // the "queue" half. Returns { ok: false, reason } immediately if the queue
  // itself is already full, or after the wait times out - this is the
  // "reject cleanly" half. `release()` must be called exactly once, however
  // the operation it was guarding finishes (success, failure, or thrown).
  acquire() {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve({ ok: true, release: () => this._release() });
    }

    if (this.queue.length >= this.maxQueue) {
      return Promise.resolve({ ok: false, reason: 'queue_full' });
    }

    return new Promise((resolve) => {
      const entry = { resolve, settled: false, timer: null };
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) this.queue.splice(idx, 1);
        resolve({ ok: false, reason: 'timeout' });
      }, this.maxWaitMs);
      this.queue.push(entry);
    });
  }

  _release() {
    this.active--;
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next.settled) continue; // already timed out; its slot was never actually taken
      next.settled = true;
      clearTimeout(next.timer);
      this.active++;
      next.resolve({ ok: true, release: () => this._release() });
      return;
    }
  }

  // For status/diagnostics only - never used to make an accept/reject decision.
  snapshot() {
    return { active: this.active, queued: this.queue.length, maxConcurrent: this.maxConcurrent, maxQueue: this.maxQueue };
  }
}

// One-at-a-time per key: `run(key, fn)` waits for every earlier run() with
// the same key to settle (success or failure) before starting fn. Used with
// the base order number as the key, around each archive operation (see
// http-server.js), so two iPads saving into the same order folder at the
// same moment can never both look at the folder, both pick the same next
// number, and race to claim it - one finishes (file renamed into place and
// read back) before the other even lists the folder. Different orders still
// run side by side, within the ConcurrencyLimiter above.
//
// Each archive operation already has its own hard time limit (worker-runner.js),
// so a hung network drive can only ever hold one order's queue for that long.
class KeyedMutex {
  constructor() {
    this.tails = new Map();
  }

  run(key, fn) {
    const previous = this.tails.get(key) || Promise.resolve();
    const result = previous.then(() => fn());
    const tail = result.then(
      () => {},
      () => {}
    );
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key); // nothing queued behind it: forget the key
    });
    return result;
  }

  // For tests/diagnostics only.
  size() {
    return this.tails.size;
  }
}

module.exports = { ConcurrencyLimiter, KeyedMutex, DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_QUEUE, DEFAULT_MAX_WAIT_MS };

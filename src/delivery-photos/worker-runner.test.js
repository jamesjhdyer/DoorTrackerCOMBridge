'use strict';

// These tests fork a REAL child process (src/worker.js) - no mocking of node:child_process.
// They are slower than the rest of the suite but they are the only thing that proves
// the timeout and crash handling actually work across a real process boundary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const { randomUUID } = require('node:crypto');

const { runInWorker, WorkerError } = require('./worker-runner');
const fsOps = require('./fs-ops');
const { makeEnv, jpeg } = require('./helpers');

// The failure-injection hooks in src/worker.js are gated behind this switch (it is
// inherited by the forked child); turn it on for this file's tests. The one test
// below that checks the switch's OFF behaviour unsets it around its own call.
process.env.DELIVERY_PHOTOS_TEST_HOOKS = '1';

test('a normal operation answers with its real result', async () => {
  const env = makeEnv();
  try {
    const result = await runInWorker('probe', { root: env.share }, { timeoutMs: 10000 });
    assert.equal(result.ok, true);
  } finally {
    env.cleanup();
  }
});

test('an operation on a bad input is reported as a WorkerError of kind "op", not a crash', async () => {
  await assert.rejects(runInWorker('probe', { root: 'relative/not-absolute' }, { timeoutMs: 10000 }), (err) => {
    assert.ok(err instanceof WorkerError);
    assert.equal(err.kind, 'op');
    return true;
  });
});

test('an unknown operation name is rejected rather than silently doing nothing', async () => {
  await assert.rejects(runInWorker('not-a-real-operation', {}, { timeoutMs: 10000 }), (err) => {
    assert.ok(err instanceof WorkerError);
    assert.equal(err.kind, 'op');
    return true;
  });
});

test('a worker that hangs (simulating a dead network share) is killed at its time limit', async () => {
  const start = Date.now();
  await assert.rejects(
    runInWorker('probe', { root: '/' }, { timeoutMs: 500, testMode: 'hang' }),
    (err) => {
      assert.ok(err instanceof WorkerError);
      assert.equal(err.kind, 'timeout');
      return true;
    }
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 450 && elapsed < 5000, `expected to be killed near the 500ms limit, took ${elapsed}ms`);
});

test('the parent process is free to do other work while the worker hangs (the hang cannot block it)', async () => {
  const hang = runInWorker('probe', { root: '/' }, { timeoutMs: 2000, testMode: 'hang' });
  const heartbeat = await new Promise((resolve) => setTimeout(() => resolve('still responsive'), 50));
  assert.equal(heartbeat, 'still responsive');
  await assert.rejects(hang, WorkerError);
});

test('a worker that crashes after doing real work (simulating power loss mid-file) is reported as a crash, and the file it already wrote survives', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('crash-mid-op', 3000);
    const spoolPath = nodePath.join(env.spool, `${randomUUID()}.jpg`);
    fs.mkdirSync(env.spool, { recursive: true });
    fs.writeFileSync(spoolPath, bytes);

    await assert.rejects(
      runInWorker(
        'archive',
        { root: env.share, reference: '5698-DELIV', photoId: randomUUID(), spoolPath, sizeBytes: bytes.length, sha256: fsOps.sha256OfBuffer(bytes) },
        { timeoutMs: 10000, testMode: 'crash-after-rename' }
      ),
      (err) => {
        assert.ok(err instanceof WorkerError);
        assert.equal(err.kind, 'crash');
        return true;
      }
    );

    assert.ok(fs.readFileSync(nodePath.join(env.share, '5698-DELIV', 'photo-001.jpg')).equals(bytes), 'the photograph must already be on the drive despite the crash');
  } finally {
    env.cleanup();
  }
});

test('the test-only failure hooks have no effect unless DELIVERY_PHOTOS_TEST_HOOKS=1 is set', async () => {
  const saved = process.env.DELIVERY_PHOTOS_TEST_HOOKS;
  delete process.env.DELIVERY_PHOTOS_TEST_HOOKS;
  try {
    const env = makeEnv();
    try {
      const result = await runInWorker('probe', { root: env.share }, { timeoutMs: 5000, testMode: 'hang' });
      assert.equal(result.ok, true, 'the "hang" test hook must be inert when the switch is off');
    } finally {
      env.cleanup();
    }
  } finally {
    if (saved === undefined) delete process.env.DELIVERY_PHOTOS_TEST_HOOKS;
    else process.env.DELIVERY_PHOTOS_TEST_HOOKS = saved;
  }
});

test('several workers can run at once without interfering with each other', async () => {
  const env = makeEnv();
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => runInWorker('probe', { root: env.share }, { timeoutMs: 10000 })));
    for (const result of results) assert.equal(result.ok, true);
  } finally {
    env.cleanup();
  }
});

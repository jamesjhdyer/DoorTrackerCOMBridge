'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

const { testNetworkStorage, StorageTestError } = require('./storage-test');
const { runInWorker } = require('./worker-runner');
const { makeEnv, LOCAL_TEST_ROOT_OPTIONS } = require('./helpers');

test('a working folder passes every step and cleans up its own test folder afterwards', async () => {
  const env = makeEnv();
  try {
    const result = await testNetworkStorage({ root: env.share, ...LOCAL_TEST_ROOT_OPTIONS });
    assert.equal(result.ok, true);
    assert.ok(result.steps.every((s) => s.ok));
    assert.ok(result.steps.some((s) => s.label.includes('verified')));

    // .incoming is the SAME shared staging folder the real archive engine
    // uses for every photograph (see fs-ops.js/archive.js) - it is meant to
    // stay, so only the test's own dated folder is checked for.
    const remaining = fs.readdirSync(env.share);
    assert.ok(!remaining.some((name) => name.startsWith('_delivery-photos-test-')), `left a test folder behind: ${remaining}`);
  } finally {
    env.cleanup();
  }
});

test('a missing folder fails clearly at the "reachable" step, before writing anything', async () => {
  const env = makeEnv();
  try {
    // Needs the test-only opt-in too, on a real Windows machine - otherwise this
    // would fail at the earlier "root" (drive-letter) step instead of the
    // "reachable" (missing folder) step this test actually means to exercise.
    await assert.rejects(testNetworkStorage({ root: nodePath.join(env.share, 'missing'), ...LOCAL_TEST_ROOT_OPTIONS }), (err) => {
      assert.ok(err instanceof StorageTestError);
      assert.equal(err.step, 'reachable');
      return true;
    });
  } finally {
    env.cleanup();
  }
});

test('a drive letter is refused unless explicitly allowed (the same rule as the real archive)', async () => {
  // Forces simulated Windows rules explicitly (platform: 'win32') rather than
  // relying on whatever OS happens to run this test - this is the one test in
  // this file that must GENUINELY prove the production rejection, so it does
  // not use LOCAL_TEST_ROOT_OPTIONS for this half of the assertion.
  await assert.rejects(testNetworkStorage({ root: 'S:\\Photos', platform: 'win32' }), StorageTestError);
  // ...and the opt-in (allowDriveLetter: true) is what a real developer/tester
  // would deliberately pass to accept one anyway - matching config.js and archive.js.
  const env = makeEnv();
  try {
    await assert.doesNotReject(testNetworkStorage({ root: env.share, ...LOCAL_TEST_ROOT_OPTIONS }));
  } finally {
    env.cleanup();
  }
});

test('an existing, unrelated file in the archive folder is left completely alone', async () => {
  const env = makeEnv();
  try {
    fs.writeFileSync(nodePath.join(env.share, 'do-not-touch.txt'), 'important customer data');
    await testNetworkStorage({ root: env.share, ...LOCAL_TEST_ROOT_OPTIONS });
    assert.equal(fs.readFileSync(nodePath.join(env.share, 'do-not-touch.txt'), 'utf8'), 'important customer data');
  } finally {
    env.cleanup();
  }
});

test('runs correctly through the real forked worker process, exactly as the Electron UI would call it', async () => {
  const env = makeEnv();
  try {
    const result = await runInWorker('storage-test', { root: env.share, ...LOCAL_TEST_ROOT_OPTIONS }, { timeoutMs: 10000 });
    assert.equal(result.ok, true);
    assert.ok(!fs.readdirSync(env.share).some((name) => name.startsWith('_delivery-photos-test-')));
  } finally {
    env.cleanup();
  }
});

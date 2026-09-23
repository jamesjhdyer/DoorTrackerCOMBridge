'use strict';

// Drives worker-entry.js as a REAL forked child process, exactly as main.js
// does - not by importing its internals. Only its own IPC messages and
// status.json are used to observe it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const { fork } = require('node:child_process');

const { saveConfig } = require('./config');
const { readStatus } = require('./status');
const { makeEnv } = require('./helpers');

const ENTRY = nodePath.join(__dirname, 'worker-entry.js');

function spawnWorker(env) {
  const child = fork(ENTRY, [], {
    env: { ...process.env, DELIVERY_PHOTOS_HOME: env.home, DELIVERY_PHOTOS_ALLOW_DRIVE_LETTER: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const statusEvents = [];
  child.on('message', (m) => {
    if (m && m.event === 'status') statusEvents.push(m.status);
  });
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, statusEvents, exited, output: () => output };
}

async function waitFor(predicate, { timeoutMs = 5000, stepMs = 50 } = {}) {
  const attempts = Math.ceil(timeoutMs / stepMs);
  for (let i = 0; i < attempts && !predicate(); i++) await new Promise((r) => setTimeout(r, stepMs));
  return predicate();
}

function configure(env, extra = {}) {
  saveConfig({ hostname: 'dp-worker-test.local', photoRoot: env.share, ...extra }, nodePath.join(env.home, 'config.json'));
}

test('with nothing configured yet, it reports not_configured over IPC rather than crashing', async () => {
  const env = makeEnv();
  const worker = spawnWorker(env);
  try {
    assert.ok(await waitFor(() => worker.statusEvents.some((s) => s.state === 'not_configured')), JSON.stringify(worker.statusEvents));
  } finally {
    worker.child.kill('SIGKILL');
    await worker.exited;
    env.cleanup();
  }
});

test('once configured, it starts the local server and reports "running" with the real hostname/port', async () => {
  const env = makeEnv();
  configure(env, { port: 8710 });
  const worker = spawnWorker(env);
  try {
    assert.ok(await waitFor(() => worker.statusEvents.some((s) => s.state === 'running')), worker.output());
    const running = worker.statusEvents.find((s) => s.state === 'running');
    assert.equal(running.hostname, 'dp-worker-test.local');
    assert.equal(running.port, 8710);
  } finally {
    worker.child.kill('SIGKILL');
    await worker.exited;
    env.cleanup();
  }
});

test('a graceful "stop" command shuts the servers down, reports "stopped", and the process exits 0', async () => {
  const env = makeEnv();
  configure(env, { port: 8712 });
  const worker = spawnWorker(env);
  try {
    assert.ok(await waitFor(() => worker.statusEvents.some((s) => s.state === 'running')), worker.output());
    worker.child.send({ cmd: 'stop' });
    const code = await worker.exited;
    assert.equal(code, 0);
    assert.ok(worker.statusEvents.some((s) => s.state === 'stopped'));
    assert.equal(readStatus(nodePath.join(env.home, 'state', 'status.json')).state, 'stopped');
    assert.equal(fs.existsSync(nodePath.join(env.home, 'state', 'worker.lock')), false, 'the lock must be released');
  } finally {
    worker.child.kill('SIGKILL');
    await worker.exited.catch(() => {});
    env.cleanup();
  }
});

test('a second worker started against the same home refuses to run alongside the first', async () => {
  const env = makeEnv();
  configure(env, { port: 8714 });
  // Spawned one AFTER THE OTHER, deliberately - not concurrently. Starting
  // both at once and assuming the one this test happens to call "first"
  // wins the lock is not a safe assumption: fork() order has no guaranteed
  // relationship to which process's own acquireLock() call reaches the
  // filesystem first (this was tried and was a genuine, if intermittent,
  // test bug). It is also the more realistic scenario: in real use, a
  // second copy would only ever be started while the first is already
  // running, not in a dead heat with it.
  const first = spawnWorker(env);
  try {
    assert.ok(await waitFor(() => first.statusEvents.some((s) => s.state === 'running')), first.output());

    const second = spawnWorker(env);
    try {
      assert.ok(await waitFor(() => second.statusEvents.some((s) => s.state === 'error')), second.output());
      assert.match(second.statusEvents.find((s) => s.state === 'error').lastError, /already running/);
      const secondCode = await second.exited;
      assert.equal(secondCode, 1);
    } finally {
      second.child.kill('SIGKILL');
      await second.exited;
    }
  } finally {
    first.child.kill('SIGKILL');
    await first.exited;
    env.cleanup();
  }
});

test('editing settings and sending "reload" applies them without needing a restart', async () => {
  const env = makeEnv();
  configure(env, { port: 8716 });
  const worker = spawnWorker(env);
  try {
    assert.ok(await waitFor(() => worker.statusEvents.some((s) => s.state === 'running' && s.port === 8716)));

    configure(env, { port: 8718 }); // the operator changes the port in the UI
    worker.child.send({ cmd: 'reload' });

    assert.ok(await waitFor(() => worker.statusEvents.some((s) => s.state === 'running' && s.port === 8718)), worker.output());
  } finally {
    worker.child.kill('SIGKILL');
    await worker.exited;
    env.cleanup();
  }
});

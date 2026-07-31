// Focused tests for the crash-safe print-attempt lifecycle in
// print-job-processor.js + print-attempt-store.js. Uses Node's built-in
// test runner (`node --test`) — no new dependency for this.
//
// printPhysically/reportJobStatus are injected fakes (see
// PrintJobProcessor's constructor) so every scenario here is deterministic
// and needs neither a real printer nor a real website. The attempt store
// is real (a temp file per test), since its actual persistence behavior
// across "runs" (fresh PrintJobProcessor instances sharing the same
// underlying file) is exactly what's under test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PrintJobProcessor } = require('./print-job-processor');
const { createPrintAttemptStore } = require('./print-attempt-store');

function tempStorePath() {
  return path.join(os.tmpdir(), `combridge-test-attempts-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const TEST_JOB = {
  jobId: 'PJ-test-job',
  widthMm: 89,
  heightMm: 36,
  labels: [{ labelKey: 'DELIVERY_LABEL', sequence: 1, imageBase64: 'aGVsbG8=' }]
};

// Runs a job through a fresh processor and waits for the queue to drain.
async function runToCompletion(processor, job, apiBase = 'https://example.test') {
  const events = [];
  processor.onEvent = (e) => events.push(e);
  processor.enqueue(job, apiBase);
  while (processor.processing || processor.queue.length > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return events;
}

function alwaysOkReporter() {
  const calls = [];
  return {
    calls,
    fn: async (apiBase, jobId, status, message) => {
      calls.push({ apiBase, jobId, status, message });
      return { ok: true };
    }
  };
}

function alwaysFailingReporter(errorMessage = 'network down') {
  const calls = [];
  return {
    calls,
    fn: async (apiBase, jobId, status, message) => {
      calls.push({ apiBase, jobId, status, message });
      return { ok: false, error: errorMessage };
    }
  };
}

// Fails only for a specific status (e.g. only PRINTED reports fail), so a
// test can isolate exactly the report this hardening is about.
function failingForStatus(targetStatus, errorMessage = 'network down') {
  const calls = [];
  return {
    calls,
    fn: async (apiBase, jobId, status, message) => {
      calls.push({ apiBase, jobId, status, message });
      if (status === targetStatus) return { ok: false, error: errorMessage };
      return { ok: true };
    }
  };
}

test('1) crash before printer submission: no local record -> normal full pipeline, no reprint risk', async () => {
  const storePath = tempStorePath();
  const store = createPrintAttemptStore(storePath);
  // Simulate "no marker exists" — a crash before setAttempting() ever ran.
  assert.equal(store.get(TEST_JOB.jobId), null);

  let printCalls = 0;
  const printer = { fn: async () => { printCalls += 1; } };
  const reporter = alwaysOkReporter();

  const processor = new PrintJobProcessor({
    priorAttemptStore: store,
    printPhysically: printer.fn,
    reportJobStatus: reporter.fn
  });

  const events = await runToCompletion(processor, TEST_JOB);

  assert.equal(printCalls, 1, 'should print exactly once');
  assert.deepEqual(events.map((e) => e.status), ['QUEUED', 'CLAIMED', 'PRINTING', 'PRINTED']);
  assert.equal(store.get(TEST_JOB.jobId), null, 'record cleared after confirmed PRINTED');
  fs.rmSync(storePath, { force: true });
});

test('2) crash during submission: recovered ATTEMPTING record -> FAILED reported, NEVER reprinted', async () => {
  const storePath = tempStorePath();
  const store = createPrintAttemptStore(storePath);
  // Simulate: a PREVIOUS run set ATTEMPTING and then crashed inside printPhysically.
  store.setAttempting(TEST_JOB.jobId);

  let printCalls = 0;
  const printer = { fn: async () => { printCalls += 1; } }; // would succeed if ever (wrongly) called
  const reporter = alwaysOkReporter();

  const processor = new PrintJobProcessor({
    priorAttemptStore: store,
    printPhysically: printer.fn,
    reportJobStatus: reporter.fn
  });

  const events = await runToCompletion(processor, TEST_JOB);

  assert.equal(printCalls, 0, 'must NOT print again for an ATTEMPTING record');
  assert.deepEqual(events.map((e) => e.status), ['QUEUED', 'FAILED']);
  assert.equal(reporter.calls.length, 1);
  assert.equal(reporter.calls[0].status, 'FAILED');
  assert.equal(store.get(TEST_JOB.jobId), null, 'record cleared once FAILED confirmed');
  fs.rmSync(storePath, { force: true });
});

test('3) submission succeeded, crash before PRINTED report: recovered SUBMITTED -> NEVER reprinted, PRINTED retried', async () => {
  const storePath = tempStorePath();
  const store = createPrintAttemptStore(storePath);
  // Simulate: a PREVIOUS run got as far as SUBMITTED and then crashed.
  store.setSubmitted(TEST_JOB.jobId);

  let printCalls = 0;
  const printer = { fn: async () => { printCalls += 1; } };
  const reporter = alwaysOkReporter();

  const processor = new PrintJobProcessor({
    priorAttemptStore: store,
    printPhysically: printer.fn,
    reportJobStatus: reporter.fn
  });

  const events = await runToCompletion(processor, TEST_JOB);

  assert.equal(printCalls, 0, 'must NOT print again for a SUBMITTED record');
  assert.deepEqual(events.map((e) => e.status), ['QUEUED', 'PRINTED', 'PRINTED']);
  assert.equal(reporter.calls.length, 1);
  assert.equal(reporter.calls[0].status, 'PRINTED');
  assert.equal(store.get(TEST_JOB.jobId), null, 'record cleared once PRINTED confirmed');
  fs.rmSync(storePath, { force: true });
});

test('4) PRINTED report fails due to network: record stays SUBMITTED, not reprinted, retried on next recovery pass', async () => {
  const storePath = tempStorePath();
  const store = createPrintAttemptStore(storePath);

  let printCalls = 0;
  const printer = { fn: async () => { printCalls += 1; } };
  const reporter = failingForStatus('PRINTED', 'simulated network failure');

  const processor = new PrintJobProcessor({
    priorAttemptStore: store,
    printPhysically: printer.fn,
    reportJobStatus: reporter.fn
  });

  const events = await runToCompletion(processor, TEST_JOB);

  assert.equal(printCalls, 1, 'physical print still happens exactly once');
  assert.equal(events[events.length - 1].status, 'PRINTED');
  assert.match(events[events.length - 1].message, /could not confirm/i);

  const record = store.get(TEST_JOB.jobId);
  assert.ok(record, 'record must NOT be cleared — PRINTED was never confirmed');
  assert.equal(record.state, 'SUBMITTED');

  // Simulate the next recovery pass (new process/connection): it must
  // retry confirming PRINTED and NOT print again, even though the same
  // job_id is enqueued into a brand-new processor instance.
  let secondRunPrintCalls = 0;
  const printer2 = { fn: async () => { secondRunPrintCalls += 1; } };
  const reporter2 = alwaysOkReporter();
  const processor2 = new PrintJobProcessor({
    priorAttemptStore: store,
    printPhysically: printer2.fn,
    reportJobStatus: reporter2.fn
  });
  const events2 = await runToCompletion(processor2, TEST_JOB);

  assert.equal(secondRunPrintCalls, 0, 'still must not reprint on the next recovery pass');
  assert.equal(reporter2.calls[0].status, 'PRINTED');
  assert.equal(store.get(TEST_JOB.jobId), null, 'now cleared once the retry succeeds');

  fs.rmSync(storePath, { force: true });
});

test('5) normal successful submission + acknowledged PRINTED: clean, no dangling record', async () => {
  const storePath = tempStorePath();
  const store = createPrintAttemptStore(storePath);

  const printer = { fn: async () => {} };
  const reporter = alwaysOkReporter();

  const processor = new PrintJobProcessor({
    priorAttemptStore: store,
    printPhysically: printer.fn,
    reportJobStatus: reporter.fn
  });

  const events = await runToCompletion(processor, TEST_JOB);

  assert.deepEqual(events.map((e) => e.status), ['QUEUED', 'CLAIMED', 'PRINTING', 'PRINTED']);
  assert.deepEqual(reporter.calls.map((c) => c.status), ['CLAIMED', 'PRINTING', 'PRINTED']);
  assert.equal(store.get(TEST_JOB.jobId), null);
  fs.rmSync(storePath, { force: true });
});

test('6) printer submission throws: reported FAILED, record cleared once confirmed, never retried as a print', async () => {
  const storePath = tempStorePath();
  const store = createPrintAttemptStore(storePath);

  let printCalls = 0;
  const printer = { fn: async () => { printCalls += 1; throw new Error('spooler rejected job'); } };
  const reporter = alwaysOkReporter();

  const processor = new PrintJobProcessor({
    priorAttemptStore: store,
    printPhysically: printer.fn,
    reportJobStatus: reporter.fn
  });

  const events = await runToCompletion(processor, TEST_JOB);

  assert.equal(printCalls, 1, 'print attempted exactly once');
  assert.deepEqual(events.map((e) => e.status), ['QUEUED', 'CLAIMED', 'PRINTING', 'FAILED']);
  assert.equal(events[events.length - 1].message, 'spooler rejected job');
  assert.equal(reporter.calls[reporter.calls.length - 1].status, 'FAILED');
  assert.equal(store.get(TEST_JOB.jobId), null, 'record cleared once FAILED confirmed');
  fs.rmSync(storePath, { force: true });
});

test('bonus: FAILED report itself fails due to network -> record stays ATTEMPTING, still not reprinted next time', async () => {
  const storePath = tempStorePath();
  const store = createPrintAttemptStore(storePath);

  let printCalls = 0;
  const printer = { fn: async () => { printCalls += 1; throw new Error('spooler rejected job'); } };
  const reporter = failingForStatus('FAILED', 'simulated network failure');

  const processor = new PrintJobProcessor({
    priorAttemptStore: store,
    printPhysically: printer.fn,
    reportJobStatus: reporter.fn
  });

  await runToCompletion(processor, TEST_JOB);

  const record = store.get(TEST_JOB.jobId);
  assert.ok(record, 'record must survive an unconfirmed FAILED report');
  assert.equal(record.state, 'ATTEMPTING');

  // Next recovery pass: must go through the ATTEMPTING-recovery branch,
  // not attempt to print again.
  let secondRunPrintCalls = 0;
  const printer2 = { fn: async () => { secondRunPrintCalls += 1; } };
  const reporter2 = alwaysOkReporter();
  const processor2 = new PrintJobProcessor({ priorAttemptStore: store, printPhysically: printer2.fn, reportJobStatus: reporter2.fn });
  await runToCompletion(processor2, TEST_JOB);

  assert.equal(secondRunPrintCalls, 0);
  assert.equal(reporter2.calls[0].status, 'FAILED');
  assert.equal(store.get(TEST_JOB.jobId), null);

  fs.rmSync(storePath, { force: true });
});

test('enqueue-once guard: same job_id is never processed twice within one running instance', async () => {
  const storePath = tempStorePath();
  const store = createPrintAttemptStore(storePath);
  let printCalls = 0;
  const printer = { fn: async () => { printCalls += 1; } };
  const reporter = alwaysOkReporter();

  const events = [];
  const processor = new PrintJobProcessor({
    onEvent: (e) => events.push(e),
    priorAttemptStore: store,
    printPhysically: printer.fn,
    reportJobStatus: reporter.fn
  });

  processor.enqueue(TEST_JOB, 'https://example.test');
  processor.enqueue(TEST_JOB, 'https://example.test'); // duplicate, e.g. a flaky double scan-response
  while (processor.processing || processor.queue.length > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.equal(printCalls, 1);
  assert.ok(events.some((e) => e.status === 'SKIPPED'));
  fs.rmSync(storePath, { force: true });
});

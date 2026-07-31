// Sequential, single-flight print-job pipeline: CLAIMED -> PRINTING ->
// PRINTED/FAILED, delegating actual physical output to printer-service.js.
//
// Every job the bridge ever handles — whether it just arrived in a scan
// response or was recovered from GET /api/print-jobs/pending after a
// restart/reconnect — is handed to the SAME enqueue() method and goes
// through the SAME processOne() pipeline. There is exactly one
// implementation of "how a job gets printed and reported", never two.
//
// Three guarantees this file is specifically responsible for:
//   - Sequential printing: a single shared instance (see main.js) serves
//     every tab/COM port, and processOne() is only ever run one at a time
//     (see drain()) — jobs from different stations can never reach the
//     physical printer concurrently.
//   - Enqueue-once per job_id: seenJobIds remembers every job_id handed to
//     this instance for the lifetime of the running process, so the same
//     job_id can never be queued, claimed, or printed twice in one run —
//     whether it shows up twice from a flaky scan response, or recovery
//     finds a job that a fresh scan already (or is about to) handle.
//   - Crash-safe recovery: priorAttemptStore (print-attempt-store.js)
//     records ATTEMPTING before a physical print attempt and SUBMITTED
//     once the printer/spooler has accepted it, and that record is cleared
//     ONLY once the website has acknowledged the resulting terminal
//     status — never just because the local physical step finished. See
//     processOne()'s handling of an existing record for exactly what a
//     restart does with each state.

const { printJob: realPrintPhysically } = require('./printer-service');
const { reportJobStatus: realReportJobStatus } = require('./print-job-client');

const REPORT_RETRY_ATTEMPTS = 3;
const REPORT_RETRY_DELAY_MS = 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reduces either shape the website sends (a freshly-created job from
// POST /api/com-scans's response, or one entry from
// GET /api/print-jobs/pending's jobs array) down to exactly what printing
// needs. Deliberately drops everything else (orderCode, profileKey,
// profileName, stationKey, ...) — the bridge prints whatever job it's
// handed and has no business logic of its own about orders/labels.
function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object' || !raw.jobId) return null;

  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((label, index) => ({
          labelKey: label && label.labelKey,
          sequence: typeof (label && label.sequence) === 'number' ? label.sequence : index,
          imageBase64: label && label.imageBase64
        }))
        .filter((label) => label.labelKey && label.imageBase64)
    : [];

  return {
    jobId: raw.jobId,
    widthMm: raw.widthMm,
    heightMm: raw.heightMm,
    labels
  };
}

class PrintJobProcessor {
  // priorAttemptStore (see print-attempt-store.js) is optional but should
  // always be supplied in the real app.
  //
  // printPhysically/reportJobStatus are injectable purely for testing
  // (see the test suite) — real callers should omit them and get the real
  // printer-service.js / print-job-client.js implementations.
  constructor({ onEvent, priorAttemptStore, printPhysically, reportJobStatus } = {}) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.priorAttemptStore = priorAttemptStore || null;
    this.printPhysically = printPhysically || realPrintPhysically;
    this.reportJobStatus = reportJobStatus || realReportJobStatus;
    this.queue = [];
    this.seenJobIds = new Set();
    this.processing = false;
  }

  emit(jobId, status, message) {
    this.onEvent({ jobId, status, message: message || '' });
  }

  // Reports a TERMINAL status (PRINTED/FAILED) with a few retries before
  // giving up for this run. This exists specifically because the caller
  // must know whether the website actually acknowledged the report before
  // it's safe to clear the local attempt-store record — unlike CLAIMED/
  // PRINTING (non-terminal, best-effort, never gate anything), a lost
  // terminal report is exactly the gap that could otherwise cause a
  // duplicate physical print after a restart.
  async reportTerminalWithRetry(apiBase, jobId, status, message) {
    let result;
    for (let attempt = 1; attempt <= REPORT_RETRY_ATTEMPTS; attempt++) {
      result = await this.reportJobStatus(apiBase, jobId, status, message);
      if (result.ok) return result;
      if (attempt < REPORT_RETRY_ATTEMPTS) await delay(REPORT_RETRY_DELAY_MS);
    }
    return result;
  }

  // Adds a job to the queue unless its job_id has already been seen by
  // this running instance (queued, currently printing, or already
  // finished) — see the module comment above for why this is the
  // duplicate/concurrent-processing guard. Safe to call from multiple
  // places (a scan response, pending-job recovery on any tab) without
  // synchronization: the check-then-add below and the processing flag in
  // drain() both run synchronously with no `await` in between, so two
  // enqueue() calls can never race each other on Node's single-threaded
  // event loop.
  enqueue(rawJob, apiBase) {
    const job = normalizeJob(rawJob);
    if (!job) return;

    if (this.seenJobIds.has(job.jobId)) {
      this.emit(job.jobId, 'SKIPPED', 'Already seen by this bridge instance — not processed again.');
      return;
    }
    this.seenJobIds.add(job.jobId);

    this.queue.push({ job, apiBase });
    this.emit(job.jobId, 'QUEUED', `Queued locally (${this.queue.length} waiting).`);
    this.drain();
  }

  async drain() {
    if (this.processing) return; // a drain() loop is already running and will pick this job up
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        await this.processOne(next.job, next.apiBase);
      }
    } finally {
      this.processing = false;
    }
  }

  async processOne(job, apiBase) {
    const { jobId } = job;
    const priorRecord = this.priorAttemptStore ? this.priorAttemptStore.get(jobId) : null;

    // SUBMITTED: a previous run got a confirmed printer/spooler acceptance
    // for this job but crashed (or lost network) before telling the
    // website — the physical label has already gone out. NEVER print
    // again; only retry confirming PRINTED. If the website still can't be
    // reached, the record is deliberately left in place so the *next*
    // reconnect/restart tries again — see the module comment.
    if (priorRecord && priorRecord.state === 'SUBMITTED') {
      const message = 'Recovered after a bridge restart — this label was already submitted to the printer previously.';
      this.emit(jobId, 'PRINTED', `${message} Confirming with website…`);
      const result = await this.reportTerminalWithRetry(apiBase, jobId, 'PRINTED', message);
      if (result.ok) {
        if (this.priorAttemptStore) this.priorAttemptStore.clear(jobId);
        this.emit(jobId, 'PRINTED', message);
      } else {
        this.emit(jobId, 'PRINTED', `${message} Still could not confirm with website (${result.error}) — will retry again next reconnect.`);
      }
      return;
    }

    // ATTEMPTING: a previous run crashed WHILE submitting — the physical
    // outcome is genuinely unknown (could have partially reached the
    // printer or not at all). Never reprint automatically; report FAILED
    // (a status the website already supports) so a human can use the
    // existing reprint mechanism if the label is still needed.
    if (priorRecord && priorRecord.state === 'ATTEMPTING') {
      const message =
        "Bridge restarted while this job's printer submission outcome was unknown — not reprinting automatically to avoid a possible duplicate. Use reprint if the label is still needed.";
      const result = await this.reportTerminalWithRetry(apiBase, jobId, 'FAILED', message);
      if (result.ok) {
        if (this.priorAttemptStore) this.priorAttemptStore.clear(jobId);
        this.emit(jobId, 'FAILED', message);
      } else {
        this.emit(jobId, 'FAILED', `${message} Could not confirm with website (${result.error}) — will retry again next reconnect.`);
      }
      return;
    }

    // Normal path — no prior local record for this job_id.
    const claimResult = await this.reportJobStatus(apiBase, jobId, 'CLAIMED');
    this.emit(jobId, 'CLAIMED', claimResult.ok ? '' : `(report failed: ${claimResult.error})`);

    // Reported immediately before attempting physical output, regardless
    // of whether CLAIMED was successfully reported — a failure to *report*
    // a status must never block the actual print attempt.
    await this.reportJobStatus(apiBase, jobId, 'PRINTING');
    this.emit(jobId, 'PRINTING', '');

    // Persisted BEFORE the risky call — if the process dies anywhere from
    // here through a successful printPhysically(), this is what recovery
    // finds on the next run.
    if (this.priorAttemptStore) this.priorAttemptStore.setAttempting(jobId);

    let submissionError = null;
    try {
      await this.printPhysically(job);
    } catch (err) {
      submissionError = (err && err.message) || String(err);
    }

    if (submissionError === null) {
      // The printer/spooler has accepted the job — persisted immediately,
      // before attempting to tell the website, so a crash in the next line
      // still leaves an accurate SUBMITTED record rather than ATTEMPTING
      // (which would otherwise wrongly report this as "outcome unknown").
      if (this.priorAttemptStore) this.priorAttemptStore.setSubmitted(jobId);
      this.emit(jobId, 'PRINTED', '');

      const result = await this.reportTerminalWithRetry(apiBase, jobId, 'PRINTED');
      if (result.ok) {
        if (this.priorAttemptStore) this.priorAttemptStore.clear(jobId);
      } else {
        this.emit(jobId, 'PRINTED', `Printed, but could not confirm with website yet (${result.error}) — will retry next reconnect.`);
      }
    } else {
      // printPhysically threw — nothing was submitted. Still routed
      // through the same retry-then-leave-the-record-in-place logic: if
      // reporting FAILED itself can't reach the website right now, the
      // ATTEMPTING record stays and a later reconnect/restart will pick it
      // up via the "ATTEMPTING" branch above rather than the failure being
      // silently lost.
      this.emit(jobId, 'FAILED', submissionError);
      const result = await this.reportTerminalWithRetry(apiBase, jobId, 'FAILED', submissionError);
      if (result.ok) {
        if (this.priorAttemptStore) this.priorAttemptStore.clear(jobId);
      } else {
        this.emit(jobId, 'FAILED', `${submissionError} (also could not confirm with website: ${result.error} — will retry next reconnect)`);
      }
    }
  }
}

module.exports = { PrintJobProcessor };

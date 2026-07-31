// Durable local record of a job's physical-print lifecycle, keyed by
// job_id, surviving a bridge crash/restart. This is what closes the
// duplicate-print recovery gap: the website's pending-job recovery treats
// a job stuck at PRINTING as non-terminal and will offer it again after a
// restart — correct in general (recovery must assume the bridge never got
// to print it), but potentially wrong if the bridge crashed partway
// through actually submitting the label. This file gives print-job-
// processor.js enough local, durable state to tell those cases apart
// without any website change.
//
// Two transient states, and no record at all once a job is fully resolved:
//
//   ATTEMPTING — persisted immediately BEFORE calling printer-service's
//     printJob(). If the process crashes anywhere from here until the
//     printer/spooler has actually accepted the job, the physical outcome
//     is genuinely unknown (could be nothing, could be a partial/garbled
//     submission) — recovery must NOT print this again. See
//     print-job-processor.js's handling of an "ATTEMPTING" record.
//
//   SUBMITTED — persisted immediately AFTER printer-service's printJob()
//     resolves successfully (the printer/spooler has accepted the job).
//     The physical label has already gone out (or at least been handed to
//     Windows) at this point — recovery must NEVER print this again,
//     no matter what. All that's left is confirming PRINTED with the
//     website, which recovery retries.
//
// A record is cleared ONLY once the corresponding terminal status
// (PRINTED for a resolved SUBMITTED, FAILED for a resolved ATTEMPTING) has
// been successfully acknowledged by the website — never just because the
// local physical step finished, since that's exactly the gap that allowed
// a duplicate print before this file existed.
const fs = require('node:fs');
const path = require('node:path');

const VALID_STATES = new Set(['ATTEMPTING', 'SUBMITTED']);

function createPrintAttemptStore(filePath) {
  function readAll() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      // Defensive against both a totally malformed file and the older
      // (pre-lifecycle) array-of-job-ids format this replaces — either way,
      // "can't make sense of this file" degrades to "no records" rather
      // than throwing, since a lost safety net is far better than a crash.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  function writeAll(records) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
    } catch {
      // Best-effort — if this can't be persisted, the bridge still prints
      // normally, it just loses this specific crash-recovery safety net.
    }
  }

  function setState(jobId, state) {
    if (!VALID_STATES.has(state)) throw new Error(`Invalid print-attempt state: ${state}`);
    const records = readAll();
    records[jobId] = { state, recordedAt: new Date().toISOString() };
    writeAll(records);
  }

  return {
    // Returns { state: 'ATTEMPTING' | 'SUBMITTED', recordedAt } or null.
    get(jobId) {
      const records = readAll();
      const record = records[jobId];
      return record && VALID_STATES.has(record.state) ? record : null;
    },
    setAttempting(jobId) {
      setState(jobId, 'ATTEMPTING');
    },
    setSubmitted(jobId) {
      setState(jobId, 'SUBMITTED');
    },
    clear(jobId) {
      const records = readAll();
      if (jobId in records) {
        delete records[jobId];
        writeAll(records);
      }
    }
  };
}

module.exports = { createPrintAttemptStore };

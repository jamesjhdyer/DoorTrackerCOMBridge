'use strict';

// Syncs the local delivery-photo tracking queue (see tracking.js) to the
// website's Google Sheets endpoint. Runs ONLY in main.js (the Electron main
// process, which already has internet access and the configured website
// address) - never in the worker, which makes no outbound internet requests
// at all (see worker-entry.js's header comment). Kept in its own module,
// with fetch/settings/logger passed in, purely so it can be tested without
// Electron.
//
// Nothing here is ever on the path that tells the iPad its photographs were
// saved - that already finished, successfully, before a tracking event is
// ever created - so the internet being slow or absent can only ever delay a
// Sheet row, never a photograph.

const { listPendingEvents, removeEvent, recordAttemptFailure } = require('./tracking');

const DEFAULT_TIMEOUT_MS = 8000;

function createTrackingSync({ queueDir, getApiBase, logger, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const status = {
    syncing: false,
    lastSyncAt: null,
    lastSyncEventId: null,
    lastSyncError: null,
    lastSyncErrorAt: null
  };

  // Posts one event. Resolves { ok: true } or { ok: false, error } - never
  // throws, so the caller's loop can always move on to the next pending
  // event regardless of this one's outcome. Same fetch+AbortController+
  // timeout shape as main.js's postScanToApi(), for the same reason: the
  // internet being slow or absent must never hang this process.
  async function postEvent(apiBase, record) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${apiBase}/api/delivery-photo-scans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: record.eventId,
          orderNumber: record.orderNumber,
          reference: record.reference,
          deliveryType: record.deliveryType,
          partNo: record.partNo,
          photosSaved: record.photosSaved,
          savedAt: record.savedAt
        }),
        signal: controller.signal
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        // a non-JSON error body still leaves response.ok to decide the outcome
      }
      if (response.ok) return { ok: true };
      return { ok: false, error: (data && (data.message || data.error)) || `HTTP ${response.status} ${response.statusText}` };
    } catch (err) {
      return { ok: false, error: err.name === 'AbortError' ? 'Request timed out' : err.message };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Attempts every currently-queued tracking event, oldest first. Safe to
  // call at any time, from any trigger (the periodic timer, a nudge from the
  // worker, app startup) - overlapping calls are simply skipped rather than
  // allowed to race each other over the same queue files. A queue file is
  // only removed once the website has genuinely acknowledged the event
  // (including "already recorded" - see the website's own eventId dedupe);
  // on any failure it stays exactly where it is for the next pass.
  async function syncPending() {
    if (status.syncing) return;
    status.syncing = true;
    try {
      const apiBase = getApiBase();
      if (!apiBase) return; // nothing configured yet - the queue just waits, nothing to log repeatedly about

      const dir = queueDir();
      const events = listPendingEvents(dir);
      for (const record of events) {
        const result = await postEvent(apiBase, record);
        if (result.ok) {
          removeEvent(dir, record.eventId);
          logger.info(`Delivery-photo tracking sync succeeded: ${record.eventId} (${record.reference}).`);
          status.lastSyncAt = new Date().toISOString();
          status.lastSyncEventId = record.eventId;
        } else {
          recordAttemptFailure(dir, record.eventId, result.error);
          logger.warn(`Delivery-photo tracking sync failed for ${record.eventId} (${record.reference}): ${result.error}. Retry scheduled.`);
          status.lastSyncError = result.error;
          status.lastSyncErrorAt = new Date().toISOString();
        }
      }
    } finally {
      status.syncing = false;
    }
  }

  return { status, postEvent, syncPending };
}

module.exports = { createTrackingSync };

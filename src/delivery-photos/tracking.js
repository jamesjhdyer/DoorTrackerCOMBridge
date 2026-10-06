'use strict';

// A durable, LOCAL record that one delivery's photographs are completely
// saved and verified - created only after every photograph in that session
// has already passed the normal archive.js read-back/checksum verification
// (see http-server.js's POST /api/delivery-sessions/complete, called by the
// iPad only once its own upload batch finished with zero failures).
//
// This file never talks to the internet itself - consistent with the rest
// of this worker process (see worker-entry.js's own header comment). It only
// creates/reads/removes small JSON files in a queue folder; main.js (the
// Electron main process, which already has the configured website address
// and already makes outbound requests for scans/print jobs) is what
// actually syncs them to Google Sheets, on its own schedule, independently
// of this process - so Sheets being slow or offline can never affect the
// worker's own HTTPS server or the archive it supervises.
//
// One JSON file per pending event, named by its own eventId, rather than a
// single shared array file: this worker only ever CREATES a file (once,
// atomically - temp then rename) and never touches it again, while main.js
// is the only thing that ever updates or removes one afterwards. Neither
// side ever needs to read-modify-write the same file the other might be
// writing at the same moment, so there is nothing to lock.

const fs = require('node:fs');
const nodePath = require('node:path');
const { randomUUID } = require('node:crypto');
const { parse: parseReference } = require('./reference');

class TrackingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrackingError';
  }
}

function deliveryTypeAndPartNo(parsed) {
  if (parsed.type === 'part') return { deliveryType: 'Part Delivery', partNo: parsed.partNumber };
  return { deliveryType: 'Full Delivery', partNo: '' };
}

function eventFilePath(queueDir, eventId) {
  return nodePath.join(queueDir, `${eventId}.json`);
}

function writeEventFile(queueDir, eventId, record) {
  fs.mkdirSync(queueDir, { recursive: true });
  const finalPath = eventFilePath(queueDir, eventId);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, finalPath);
}

// Called once, right after the iPad reports that every photograph in a
// delivery session has already been saved and read-back verified - never
// before that point. `reference` must already be the canonical, validated
// form (http-server.js parses it before calling this). Throws TrackingError
// if `photosSaved` is not a real positive count - a session with nothing
// successfully saved is not a trackable event at all.
function createTrackingEvent({ reference, photosSaved }, { queueDir, now = () => new Date() }) {
  const parsed = parseReference(reference);
  if (!parsed.ok) throw new TrackingError(`cannot track an invalid delivery reference: ${parsed.reason}`);
  if (!Number.isInteger(photosSaved) || photosSaved < 1) throw new TrackingError('photosSaved must be a positive whole number');

  const { deliveryType, partNo } = deliveryTypeAndPartNo(parsed);
  const eventId = randomUUID();
  const savedAt = now().toISOString();

  const record = {
    eventId,
    orderNumber: parsed.orderNumber,
    reference: parsed.reference,
    deliveryType,
    partNo,
    photosSaved,
    savedAt,
    createdAt: savedAt,
    attempts: 0,
    lastAttemptAt: '',
    lastError: ''
  };

  writeEventFile(queueDir, eventId, record);
  return record;
}

// Every pending (not yet synced) event, oldest first. Tolerant of a
// half-written or corrupted file (skips it rather than throwing) - a queue
// folder is read far more often than it is written, and one bad file must
// never hide every other real pending event from the sync loop.
function listPendingEvents(queueDir) {
  let names;
  try {
    names = fs.readdirSync(queueDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const events = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // skips any stray *.tmp left by a crash mid-write
    try {
      const record = JSON.parse(fs.readFileSync(nodePath.join(queueDir, name), 'utf8'));
      if (record && record.eventId) events.push(record);
    } catch {
      // one unreadable file must not take down the whole sync pass
    }
  }
  return events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Called once Google Sheets has genuinely acknowledged the event (or
// reported it as already present, which is equally a success - see the
// website's own eventId dedupe). Idempotent: removing an already-removed
// file is not an error.
function removeEvent(queueDir, eventId) {
  fs.rmSync(eventFilePath(queueDir, eventId), { force: true });
}

// Called after a sync attempt fails, so the next attempt (and the status
// panel) can show something more useful than silence. Never throws - a
// failure to record a failure must not itself become a crash.
function recordAttemptFailure(queueDir, eventId, errorMessage, now = () => new Date()) {
  const filePath = eventFilePath(queueDir, eventId);
  try {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    record.attempts = (record.attempts || 0) + 1;
    record.lastAttemptAt = now().toISOString();
    record.lastError = String(errorMessage || '').slice(0, 300);
    writeEventFile(queueDir, eventId, record);
  } catch {
    // the file may already be gone (a concurrent success) or unreadable -
    // either way, nothing useful to record
  }
}

module.exports = { TrackingError, createTrackingEvent, listPendingEvents, removeEvent, recordAttemptFailure };

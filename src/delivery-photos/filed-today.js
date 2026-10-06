'use strict';

// A small, LOCAL, append-only record of every delivery-photo session that
// has completely saved and verified on the company drive - kept purely so
// the Windows app can show "Orders filed today" without needing the
// internet or Google Sheets at all.
//
// Deliberately separate from tracking.js's queue: a queue file is removed
// once it reaches Google Sheets, so the queue can never answer "what was
// filed today". This ledger is written at the exact same moment a tracking
// event is created (see http-server.js's handleSessionComplete - i.e. only
// after the iPad reports every photograph in the session already saved and
// read-back verified), and never touched again.
//
// One file per workshop calendar day (e.g. "2026-10-06.jsonl"), one JSON
// line per completed session. Counting today therefore only ever reads
// today's file, and the figure resets on its own when the date changes.

const fs = require('node:fs');
const nodePath = require('node:path');
const { parse: parseReference } = require('./reference');

// "Today" means the UK workshop's own calendar date - never UTC, and never
// whatever time zone the PC happens to be set to.
const WORKSHOP_TIME_ZONE = 'Europe/London';

const dateKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: WORKSHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

// "YYYY-MM-DD" for the workshop's local date of `date` (a Date or ISO string).
function workshopDateKey(date) {
  return dateKeyFormat.format(new Date(date));
}

function dayFilePath(dir, dateKey) {
  return nodePath.join(dir, `${dateKey}.jsonl`);
}

// Appends one completed session to the ledger for the workshop date of its
// own `savedAt`. A single appendFileSync of one short line - this worker is
// the only writer, and main.js only ever reads.
function recordFiledSession(dir, { eventId, reference, savedAt }) {
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ eventId, reference, savedAt });
  fs.appendFileSync(dayFilePath(dir, workshopDateKey(savedAt)), `${line}\n`, 'utf8');
}

// The number of UNIQUE order numbers filed on the workshop date of `now` -
// not photographs, not sessions, and not part deliveries separately: e.g.
// 5698-DELIV, 5698-P-DELIV and 5698-P2-DELIV are all order 5698, and
// 5626-2-DELIV / 5626-2-P2-DELIV are both order 5626-2. The order number
// comes from reference.js's parser, never from splitting the text by hand.
// Tolerant of a missing file (nothing filed yet today) and of any single
// unreadable line.
function countOrdersFiledOn(dir, now = new Date()) {
  const todayKey = workshopDateKey(now);
  let text;
  try {
    text = fs.readFileSync(dayFilePath(dir, todayKey), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }

  const orders = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (workshopDateKey(entry.savedAt) !== todayKey) continue;
      const parsed = parseReference(entry.reference);
      if (parsed.ok) orders.add(parsed.orderNumber);
    } catch {
      // one bad line must not hide every other order filed today
    }
  }
  return orders.size;
}

module.exports = { WORKSHOP_TIME_ZONE, workshopDateKey, recordFiledSession, countOrdersFiledOn };

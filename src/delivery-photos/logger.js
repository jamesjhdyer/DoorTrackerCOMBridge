'use strict';

// One plain-text log file per day (logs/delivery-photos-YYYY-MM-DD.log), kept
// for two weeks. Secrets passed in are replaced with *** wherever they
// appear. A log that cannot be written never stops the worker: it falls back
// to the console.

const fs = require('node:fs');
const nodePath = require('node:path');
const { sanitizeText } = require('./sanitize');

const KEEP_DAYS = 14;

function localDate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function pruneOldLogs(dir, now) {
  const cutoff = now.getTime() - KEEP_DAYS * 24 * 3600 * 1000;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^delivery-photos-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const file = nodePath.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch {
    // pruning is housekeeping only
  }
}

function createLogger({ dir, echo = false, secrets = [], roots = [], now = () => new Date() } = {}) {
  let writable = Boolean(dir);
  if (writable) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      pruneOldLogs(dir, now());
    } catch {
      writable = false;
    }
  }

  function write(level, message) {
    const moment = now();
    const line = `${moment.toISOString()} ${level.padEnd(5)} ${sanitizeText(message, { secrets, roots })}`;
    if (writable) {
      try {
        fs.appendFileSync(nodePath.join(dir, `delivery-photos-${localDate(moment)}.log`), `${line}\n`);
      } catch {
        writable = false;
      }
    }
    if (echo || !writable) console.log(line);
  }

  return {
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message)
  };
}

module.exports = { createLogger, localDate, KEEP_DAYS };

'use strict';

// Recent log entries for the admin page's Logs section. Only ever reads the
// fixed daily log files named in `sources` (e.g. com-bridge-YYYY-MM-DD.log in
// one known folder) - the request only picks WHICH source by name, never a
// folder, file name or path, so this can never become a file browser.
//
// Every line is redacted again on the way out (see redact()), on top of the
// redaction the loggers already do when writing, so even a secret that
// somehow reached a log file is not served to the browser.

const fs = require('node:fs');
const nodePath = require('node:path');

const MAX_ENTRIES = 200;
const MAX_FILES = 3; // today and up to two previous log days
const MAX_BYTES_PER_FILE = 512 * 1024;

function redact(text) {
  return String(text)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted key]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .replace(/\b(password|passwd|pin|token|secret|cookie|authorization|csrf)(\s*[=:]\s*)("?)[^\s",;]+/gi, '$1$2$3***')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '***')
    .replace(/[A-Za-z0-9_-]{40,}/g, '***');
}

// "2026-11-02T14:32:18.123Z WARN  message..." -> { timestamp, level, message }
function parseLine(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s+(INFO|WARN|ERROR)\s+(.*)$/.exec(line);
  if (!match) return null;
  return { timestamp: match[1], level: match[2], message: redact(match[3]).slice(0, 500) };
}

function readTail(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, MAX_BYTES_PER_FILE);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A partial first line (cut by the byte limit) is dropped.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// Newest first. `sources` maps a name the browser may ask for to
// { dir, prefix }; an unknown name returns null (the caller answers 400).
function readRecentLogs(sources, sourceName, limit = 100) {
  if (!Object.prototype.hasOwnProperty.call(sources, sourceName)) return null;
  const { dir, prefix } = sources[sourceName];
  const count = Math.max(1, Math.min(MAX_ENTRIES, Number.isInteger(limit) ? limit : 100));
  const pattern = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.log$`);

  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => pattern.test(name)).sort().reverse().slice(0, MAX_FILES);
  } catch {
    return [];
  }

  const entries = [];
  for (const name of names) {
    let lines;
    try {
      lines = readTail(nodePath.join(dir, name)).split('\n');
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0 && entries.length < count; i--) {
      const entry = parseLine(lines[i]);
      if (entry) entries.push({ ...entry, component: sourceName });
    }
    if (entries.length >= count) break;
  }
  return entries;
}

module.exports = { readRecentLogs, redact, parseLine, MAX_ENTRIES };

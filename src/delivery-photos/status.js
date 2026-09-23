'use strict';

// The running Bridge writes a small status file every cycle so the menu (a
// different process) can say whether it is alive, when it last spoke to the
// website, how many photographs it has filed and what last went wrong.

const fs = require('node:fs');
const nodePath = require('node:path');
const { defaultIsAlive } = require('./lock');

function createStatusFile(filePath, initial = {}, now = () => new Date()) {
  let current = { ...initial };

  function write(patch = {}) {
    current = { ...current, ...patch, updatedAt: now().toISOString() };
    try {
      fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
      const temp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(current, null, 2));
      fs.renameSync(temp, filePath);
    } catch {
      // status is a courtesy; it must never stop photographs being filed
    }
    return current;
  }

  return { write, get: () => current };
}

function readStatus(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ago(iso, nowMs) {
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'never';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} seconds ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} hours ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

// { running, lines } - "running" means the process exists AND has reported recently.
function describeStatus(status, { nowMs = Date.now(), isAlive = defaultIsAlive } = {}) {
  if (!status) return { running: false, lines: ['The Delivery Photos worker has never run on this PC (no status file yet).'] };

  const staleAfterMs = Math.max(90, (Number(status.pollSeconds) || 15) * 4) * 1000;
  const fresh = nowMs - Date.parse(status.updatedAt) < staleAfterMs;
  const alive = Number.isFinite(Number(status.pid)) && isAlive(Number(status.pid));
  const running = Boolean(alive && fresh && status.state !== 'stopped');

  const lines = [];
  if (running) lines.push(`RUNNING (process ${status.pid}, version ${status.version || '?'}, started ${ago(status.startedAt, nowMs)})`);
  else if (status.state === 'stopped') lines.push(`NOT RUNNING - stopped ${ago(status.updatedAt, nowMs)}`);
  else lines.push(`NOT RUNNING - it last reported ${ago(status.updatedAt, nowMs)}${alive ? ' (the process exists but has gone quiet)' : ''}`);

  lines.push(`Last check of the website: ${status.lastPollAt ? ago(status.lastPollAt, nowMs) : 'never'}${status.lastPollAt ? (status.lastPollOk ? ' - OK' : ' - FAILED') : ''}`);
  lines.push(`Network folder: ${status.shareOk === undefined ? 'not checked yet' : status.shareOk ? 'reachable' : 'NOT reachable'}${status.freeGb ? `, ${status.freeGb} GB free` : ''}`);
  lines.push(`Photographs filed since it started: ${status.filed || 0}   failed attempts: ${status.failed || 0}`);
  if (status.lastFiledAt) lines.push(`Last photograph filed: ${ago(status.lastFiledAt, nowMs)}`);
  if (status.lastError) lines.push(`Last problem: ${status.lastError}`);
  return { running, lines };
}

module.exports = { createStatusFile, readStatus, describeStatus, ago };

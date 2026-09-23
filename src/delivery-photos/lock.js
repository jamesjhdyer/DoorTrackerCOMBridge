'use strict';

// Only one Delivery Photos worker may run per PC. The lock is a small file holding the
// process id; the running Bridge touches it every cycle. A lock left behind by a
// crash (or by a Windows restart) is recognised as stale and taken over: either
// its process no longer exists, or it has not been touched for a long time (which
// also covers a process id that Windows later gave to something else).

const fs = require('node:fs');
const nodePath = require('node:path');

const DEFAULT_STALE_MS = 10 * 60 * 1000;

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // it exists but belongs to someone else
  }
}

function readLock(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return { pid: Number(parsed.pid), mtimeMs: fs.statSync(lockPath).mtimeMs };
  } catch {
    return null;
  }
}

function acquireLock(lockPath, { pid = process.pid, isAlive = defaultIsAlive, staleMs = DEFAULT_STALE_MS, now = () => Date.now() } = {}) {
  fs.mkdirSync(nodePath.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAt: new Date(now()).toISOString() }), { flag: 'wx' });
      return {
        ok: true,
        touch() {
          try {
            const time = new Date(now());
            fs.utimesSync(lockPath, time, time);
          } catch {
            // the lock is advisory; a failed touch must not stop the Bridge
          }
        },
        release() {
          const held = readLock(lockPath);
          if (held && held.pid === pid) fs.rmSync(lockPath, { force: true });
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const held = readLock(lockPath);
    const stale = !held || !Number.isFinite(held.pid) || !isAlive(held.pid) || now() - held.mtimeMs > staleMs;
    if (!stale) return { ok: false, pid: held.pid };
    fs.rmSync(lockPath, { force: true });
  }
  return { ok: false, pid: null };
}

module.exports = { acquireLock, defaultIsAlive, DEFAULT_STALE_MS };

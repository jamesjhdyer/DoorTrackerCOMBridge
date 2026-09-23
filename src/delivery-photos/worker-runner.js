'use strict';

// Runs one network-drive operation in a separate process with a hard time limit.
//
// Why a process and not just a Promise.race: a file call to an unreachable share
// blocks inside Windows for a long time and Node cannot interrupt it. Only killing
// the whole process reliably ends it - so the scanner-facing parts of the Bridge
// (talking to the website, writing the status) can never be stalled by the drive.

const { fork } = require('node:child_process');
const nodePath = require('node:path');

const WORKER = nodePath.join(__dirname, 'worker.js');

class WorkerError extends Error {
  // kind: 'timeout' | 'crash' | 'op'
  constructor(kind, message, code = '') {
    super(message);
    this.name = 'WorkerError';
    this.kind = kind;
    this.code = code;
  }
}

function runInWorker(operation, params, { timeoutMs = 120000, testMode } = {}) {
  return new Promise((resolve, reject) => {
    // A clean environment for the child: no inherited runner flags.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, execArgv: [], env });

    let settled = false;
    let timer = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      settle(value);
    };

    timer = setTimeout(() => finish(reject, new WorkerError('timeout', `the network folder did not answer within ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
    child.on('message', (message) => {
      if (message && message.ok) finish(resolve, message.result);
      else finish(reject, new WorkerError('op', (message && message.error && message.error.message) || 'unknown error', (message && message.error && message.error.code) || ''));
    });
    child.on('error', (err) => finish(reject, new WorkerError('crash', `the file worker could not start (${err.message})`)));
    // The worker exits right after answering, and Node does not strictly order "answer arrived" before
    // "process exited". A short grace period lets a real answer win; only silence counts as a crash.
    child.on('exit', (code, signal) =>
      setTimeout(() => finish(reject, new WorkerError('crash', `the file worker stopped unexpectedly (${signal || `exit code ${code}`})`)), 250)
    );
    child.send({ op: operation, params, testMode });
  });
}

module.exports = { runInWorker, WorkerError };

'use strict';

// Shared test-only utilities for the Delivery Photos worker's tests. Named
// "helpers.js" (not "*.test.js"/"test-*.js"/etc.) specifically so Node's
// default test-file discovery (node --test, no explicit file list - see
// package.json) never mistakes it for a test file in its own right.

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { randomBytes } = require('node:crypto');
const { makeDummyJpeg } = require('./jpeg-fixture');

function makeEnv(prefix = 'dp-test-') {
  const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
  const share = nodePath.join(base, 'share'); // stands in for the network drive
  const home = nodePath.join(base, 'home');
  fs.mkdirSync(share);
  fs.mkdirSync(home);
  return {
    base,
    share,
    home,
    spool: nodePath.join(home, 'spool'),
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

const jpeg = (label, bytes = 3000) => makeDummyJpeg({ label, targetBytes: bytes });

function quietLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return { info: push('INFO'), warn: push('WARN'), error: push('ERROR'), lines };
}

module.exports = { makeEnv, jpeg, quietLogger };

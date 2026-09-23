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

// makeEnv()'s `share` folder stands in for the network drive, but it is a
// REAL local temp folder - on a real Windows machine (including GitHub
// Actions' own Windows runners, which put the checkout and temp folders on a
// D:\ drive), that makes it a genuine drive-letter path. Production code
// must NEVER accept one there (see safe-path.js's classifyRoot/archive.js's
// checkRoot/config.js's validateConfig) - a mapped or lettered drive is not
// something a background worker or scheduled task can rely on existing. That
// production rule is exactly what this constant deliberately, explicitly
// opts OUT of, for tests only: spread it into any call that passes
// `root`/`photoRoot: env.share` (or similar) to probeRoot, sweepIncoming,
// archivePhoto, testNetworkStorage, or a runWorker()/startServers() config -
// on macOS it is a no-op (the posix-dev path-shape branch does not consult
// this flag at all), and on a real Windows runner it is what stops every one
// of those real-file-I/O tests from being wrongly rejected by the SAME rule
// that must keep rejecting a real drive letter in the packaged app. A test
// that is specifically proving the production rejection itself (a real
// person typing "S:\Photos" into Set Up, say) must NOT use this - it should
// assert the rejection, typically forcing platform: 'win32' explicitly so
// the assertion holds regardless of which OS runs the test.
const LOCAL_TEST_ROOT_OPTIONS = Object.freeze({ allowDriveLetter: true });

const jpeg = (label, bytes = 3000) => makeDummyJpeg({ label, targetBytes: bytes });

function quietLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return { info: push('INFO'), warn: push('WARN'), error: push('ERROR'), lines };
}

module.exports = { makeEnv, jpeg, quietLogger, LOCAL_TEST_ROOT_OPTIONS };

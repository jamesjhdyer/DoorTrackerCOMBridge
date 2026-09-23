'use strict';

// "Test Network Storage" - the one button in the Delivery Photos panel that
// proves the configured archive folder genuinely works, using a dummy
// photograph, before anyone relies on it for a real delivery. Runs inside
// the same forked worker process the real archiving uses (see worker.js and
// worker-runner.js) - a hung network drive can hang THIS check without ever
// touching the scanner/printer code or the rest of the Delivery Photos
// server.
//
// Unlike a real delivery photograph, the test folder and file are created,
// verified AND removed again automatically in one step - this is a quick,
// repeatable diagnostic run from inside the already-trusted management app,
// not a separate cautious tool handed to someone unfamiliar with it.

const fs = require('node:fs/promises');
const nodePath = require('node:path');
const { randomUUID } = require('node:crypto');
const fsOps = require('./fs-ops');
const { INCOMING_DIR_NAME, TEST_CANARY_NAME, classifyRoot, resolveInsideRoot } = require('./safe-path');
const { makeDummyJpeg } = require('./jpeg-fixture');

const GB = 1024 ** 3;

class StorageTestError extends Error {
  constructor(step, message) {
    super(message);
    this.name = 'StorageTestError';
    this.step = step;
  }
}

function testDirName() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `_delivery-photos-test-${stamp}-${randomUUID().slice(0, 8)}`;
}

// Runs entirely inside the worker process (see worker.js's OPERATIONS map).
// Returns a report the UI can show directly; throws StorageTestError with a
// plain-language message on any real failure - never partially succeeds
// silently.
async function testNetworkStorage({ root, allowDriveLetter = false, platform } = {}) {
  const steps = [];
  const record = (label, ok, detail) => steps.push({ label, ok, detail: detail || '' });

  const rootInfo = classifyRoot(root, platform);
  if (!rootInfo.ok) throw new StorageTestError('root', `The archive folder is not usable: ${rootInfo.reason}`);
  if (rootInfo.kind === 'drive-letter' && !allowDriveLetter) throw new StorageTestError('root', 'The archive folder is a mapped drive letter; use the \\\\server\\share\\... path.');

  let stats;
  try {
    stats = await fs.lstat(root);
  } catch (err) {
    throw new StorageTestError('reachable', err.code === 'ENOENT' ? 'The archive folder does not exist, or the network drive is not reachable right now.' : `Could not open the archive folder (${err.code || err.message}).`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new StorageTestError('reachable', 'The archive folder is not a plain folder.');
  record('Folder reachable', true);

  const space = await fsOps.getFreeSpace(root);
  if (space.ok) record('Free space', true, `${(space.freeBytes / GB).toFixed(1)} GB`);
  else record('Free space', true, 'Could not be determined (not fatal)');

  const dirName = testDirName();
  const testDir = resolveInsideRoot(root, [dirName]);
  const incoming = resolveInsideRoot(root, [INCOMING_DIR_NAME]);
  await fs.mkdir(incoming, { recursive: true });
  await fs.mkdir(testDir);
  record('Test folder created', true, dirName);

  try {
    const bytes = makeDummyJpeg({ label: 'delivery-photos-network-test', targetBytes: 500000 });
    const { finalPath } = await fsOps.publishNewFile({ tempDir: incoming, finalDir: testDir, finalName: TEST_CANARY_NAME, data: bytes });
    record('Dummy photograph written', true, `${bytes.length} bytes`);

    const check = await fsOps.verifyFile(finalPath, { size: bytes.length, sha256: fsOps.sha256OfBuffer(bytes) });
    if (!check.ok) throw new StorageTestError('verify', `The file read back from the drive did not match (${check.problems.join('; ')}).`);
    record('Read back and verified (size + SHA-256)', true);
  } finally {
    // Always attempted, even if verification failed above - this test must
    // never leave debris behind on the real archive folder.
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    record('Test folder removed', true);
  }

  return { ok: true, steps };
}

module.exports = { testNetworkStorage, StorageTestError };

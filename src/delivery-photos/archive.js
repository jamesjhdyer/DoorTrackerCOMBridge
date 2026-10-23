'use strict';

// Everything that touches the network drive on behalf of the Delivery Photos worker. These
// functions run inside a separate short-lived worker process (see worker.js and
// worker-runner.js): a call to a share that has stopped answering can hang for a
// long time and Node cannot cancel it, so the parent gives every operation a time
// limit and simply kills the worker if it does not finish.
//
// Rules this file enforces:
//   - The order folder name comes only from a strictly validated base order number
//     (5698, 5626-2) and the file name is generated HERE, from the next free sequence
//     number and the role suffix (001-DELIV.jpg, 002-BENCH.jpg, 003-IRN.jpg) - never
//     a folder, file name or path supplied by the iPad.
//   - The order folder is shared by every role, and numbered across the WHOLE
//     folder: the next number is one past the highest number any existing file
//     claims (see NUMBERED_FILE_PATTERN), never a count of files, never a reused gap.
//   - Callers must not run two archivePhoto() calls for the same order folder at
//     once - http-server.js holds a per-order lock around each call (see
//     concurrency.js's KeyedMutex), and the worker is single-instance (lock.js).
//   - Historical <ORDER>-DELIV folders from before the order-folder layout are
//     never opened, moved, renamed or written to.
//   - The archive root must already exist. It is never created.
//   - A photograph is written to <root>/.incoming/<uuid>.part, flushed, and only
//     then renamed into place. Existing files are never overwritten.
//   - Nothing is reported as filed until the file has been READ BACK from the drive
//     and its size and SHA-256 match.
//   - A retry after a crash finds the file already written and reuses it instead of
//     writing a duplicate.

const fs = require('node:fs/promises');
const nodePath = require('node:path');
const fsOps = require('./fs-ops');
const {
  INCOMING_DIR_NAME,
  NUMBERED_FILE_PATTERN,
  assertOrderFolderName,
  assertPhotoFileName,
  classifyRoot,
  resolveInsideRoot
} = require('./safe-path');

const { SUFFIXES } = require('./photo-roles');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SEQUENCE = 999999;
const MAX_NAME_ATTEMPTS = 20;
const SHA256 = /^[0-9a-f]{64}$/;
const GB = 1024 ** 3;

class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

// `platform` defaults to classifyRoot's own default (the real process.platform)
// and exists as an explicit parameter purely so the automated tests can prove
// these Windows rules from any development machine, exactly like config.js and
// storage-test.js already do - it is never set by any real caller. Both a UNC
// path and a mapped drive letter are accepted here: the Delivery Photos worker
// is always forked from the interactive, logged-in COM Bridge app, so it
// inherits that session's own drive mappings exactly as Explorer does. Only
// the path SHAPE is judged here (see classifyRoot) - never converted or
// guessed from one form to the other.
function checkRoot(root, platform) {
  const info = classifyRoot(root, platform);
  if (!info.ok) throw new ArchiveError('BAD_ROOT', `the archive folder is not usable: ${info.reason}`);
}

// Every filesystem call the worker makes on the configured root goes through
// here first, so the single most common real-world failure - the share is
// unplugged, unmounted, or the account has no permission to it - always comes
// back as a plain ArchiveError with a stable code, never a raw Node ENOENT/EACCES
// exception (which would carry a real filesystem path and an unpredictable shape).
async function requireRoot(root, platform) {
  let stats;
  try {
    stats = await fs.lstat(root);
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new ArchiveError('ROOT_DENIED', 'this account does not have permission to open the archive folder');

    // A mapped drive letter that is not currently connected (e.g. right
    // after Windows login, before the logon script/GPO remaps it) can fail
    // here with any of several OS error codes depending on exactly why the
    // letter is not there - not reliably ENOENT alone. Checked directly
    // (is the bare drive itself reachable?) rather than guessed from the
    // error code, and only reported as "waiting for the drive" when the
    // drive really is the problem - a drive that IS connected but whose
    // configured sub-folder is missing (a typo in Setup, say) gets its own,
    // different message instead of wrongly blaming the drive.
    const info = classifyRoot(root, platform);
    if (info.ok && info.kind === 'drive-letter') {
      const driveOk = await fsOps.driveRootReachable(info.drive);
      if (!driveOk) throw new ArchiveError('ROOT_NOT_FOUND', `Network drive unavailable — waiting for ${info.drive}:`);
      throw new ArchiveError('ROOT_NOT_FOUND', `the ${info.drive}: drive is connected, but the configured folder does not exist on it`);
    }

    if (err.code === 'ENOENT') throw new ArchiveError('ROOT_NOT_FOUND', 'the archive folder does not exist, or the network drive is not reachable right now');
    throw new ArchiveError('ROOT_UNREADABLE', `the archive folder could not be checked (${err.code || err.message})`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ArchiveError('BAD_ROOT', 'the archive folder is not a plain folder');
}

async function ensureDirectory(dirPath) {
  try {
    await fs.mkdir(dirPath); // never recursive: a missing parent means the share is not what we expect
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const stats = await fs.lstat(dirPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ArchiveError('NOT_A_FOLDER', 'an item that should be a folder is something else');
}

// Is the archive folder there, and how much room is left? (Read-only.)
async function probeRoot({ root, platform }) {
  checkRoot(root, platform);
  await requireRoot(root, platform);
  const space = await fsOps.getFreeSpace(root);
  return { ok: true, freeBytes: space.ok ? space.freeBytes : null };
}

// Every file in the order folder whose name claims a sequence number (any
// role, any letter case - see NUMBERED_FILE_PATTERN), with its number and
// size. Sub-folders, and files that claim no number, are ignored.
async function listNumberedFiles(folder) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = NUMBERED_FILE_PATTERN.exec(entry.name);
    if (!match) continue;
    const stats = await fs.lstat(nodePath.join(folder, entry.name));
    files.push({ name: entry.name, number: Number(match[1]), size: stats.size });
  }
  return files;
}

function photoFileName(number, suffix) {
  return `${String(number).padStart(3, '0')}-${suffix}.jpg`;
}

// Files the Bridge wrote and then had to give up on (killed part-way) are removed
// at the start of the next job. Only names that match our own <uuid>.part pattern are touched.
async function sweepIncoming({ root, platform }) {
  checkRoot(root, platform);
  await requireRoot(root, platform);
  const incoming = resolveInsideRoot(root, [INCOMING_DIR_NAME]);
  try {
    return { removed: (await fsOps.sweepTempFiles(incoming)).length };
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: 0 };
    throw err;
  }
}

// Files one photograph (already downloaded to the local spool) into
// <root>/<baseOrder>/<NNN>-<photoRole>.jpg. `photoRole` is the role SUFFIX
// (DELIV, BENCH or IRN), decided by the server from the device's pairing.
// `hooks.afterPublish` exists only so tests can simulate a crash right after the rename.
async function archivePhoto(params, hooks = {}) {
  const { root, baseOrder, photoRole, photoId, spoolPath, sizeBytes, sha256, platform, minFreeGb = 0 } = params;

  if (!UUID.test(String(photoId))) throw new ArchiveError('BAD_INPUT', 'invalid photograph id');
  if (!SHA256.test(String(sha256)) || !Number.isInteger(sizeBytes) || sizeBytes < 1) throw new ArchiveError('BAD_INPUT', 'invalid size or checksum');
  if (typeof spoolPath !== 'string' || !nodePath.isAbsolute(spoolPath)) throw new ArchiveError('BAD_INPUT', 'invalid local file');
  if (!SUFFIXES.includes(photoRole)) throw new ArchiveError('BAD_ROLE', 'invalid photo role');
  let folderName;
  try {
    folderName = assertOrderFolderName(baseOrder);
  } catch (err) {
    // Re-thrown as our own error type: every failure this module raises is an
    // ArchiveError, never an internal detail of the safe-path module.
    throw new ArchiveError('BAD_ORDER', err.message);
  }

  checkRoot(root, platform);
  await requireRoot(root, platform);

  // Checked before anything is read or written, so a low-space rejection
  // can never leave a partial file behind - the whole point of minFreeGb.
  // `space.ok === false` means free space could not be determined at all
  // (fs.statfs unavailable, or the share didn't answer it) - that is its own
  // normal, reported outcome elsewhere (see fs-ops.js/storage-test.js), and
  // is NOT treated as "below the threshold" here: an indeterminate reading
  // must never be the reason archiving stops working entirely.
  if (minFreeGb > 0) {
    const space = await fsOps.getFreeSpace(root);
    if (space.ok && space.freeBytes < minFreeGb * GB) {
      const freeGb = (space.freeBytes / GB).toFixed(1);
      throw new ArchiveError('INSUFFICIENT_SPACE', `the archive drive has only ${freeGb} GB free, below the configured minimum of ${minFreeGb} GB - nothing was written`);
    }
  }

  const data = await fs.readFile(spoolPath);
  if (data.length !== sizeBytes || fsOps.sha256OfBuffer(data) !== sha256) {
    throw new ArchiveError('SPOOL_MISMATCH', 'the downloaded file does not match its checksum');
  }

  const incoming = resolveInsideRoot(root, [INCOMING_DIR_NAME]);
  await ensureDirectory(incoming);
  await fsOps.sweepTempFiles(incoming);

  // Created if new, reused if it already exists (created earlier by any role).
  const folder = resolveInsideRoot(root, [folderName]);
  await ensureDirectory(folder);

  // A retry of a photograph that is already filed (the iPad never heard the
  // answer, or the worker crashed after the rename) finds its own file - same
  // role, same size, same SHA-256 - and reuses it: no second file, and no
  // sequence number consumed.
  const existing = await listNumberedFiles(folder);
  const ownSuffix = new RegExp(`-${photoRole}\\.jpg$`);
  for (const file of existing) {
    if (file.size !== sizeBytes || !ownSuffix.test(file.name)) continue;
    const check = await fsOps.verifyFile(nodePath.join(folder, file.name), { size: sizeBytes, sha256 });
    if (check.ok) return { storagePath: `${folderName}/${file.name}`, adopted: true, sizeBytes, sha256 };
  }

  let number = existing.reduce((highest, file) => Math.max(highest, file.number), 0) + 1;
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS && number <= MAX_SEQUENCE; attempt++, number++) {
    const name = photoFileName(number, photoRole);
    assertPhotoFileName(name);
    let finalPath;
    try {
      ({ finalPath } = await fsOps.publishNewFile({ tempDir: incoming, finalDir: folder, finalName: name, data }));
    } catch (err) {
      if (err instanceof fsOps.AlreadyExistsError) continue; // that exact name appeared meanwhile: take the next number, never overwrite
      throw err;
    }
    if (hooks.afterPublish) await hooks.afterPublish();

    const check = await fsOps.verifyFile(finalPath, { size: sizeBytes, sha256 });
    if (!check.ok) {
      await fs.unlink(finalPath).catch(() => {}); // our own file, just written, and wrong: remove it so a retry starts clean
      throw new ArchiveError('VERIFY_FAILED', `the file read back from the drive did not match (${check.problems.join('; ')})`);
    }
    return { storagePath: `${folderName}/${name}`, adopted: false, sizeBytes, sha256 };
  }
  throw new ArchiveError('NO_FREE_NAME', 'could not find a free photograph number');
}

module.exports = { ArchiveError, probeRoot, sweepIncoming, archivePhoto };

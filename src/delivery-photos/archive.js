'use strict';

// Everything that touches the network drive on behalf of the Delivery Photos worker. These
// functions run inside a separate short-lived worker process (see worker.js and
// worker-runner.js): a call to a share that has stopped answering can hang for a
// long time and Node cannot cancel it, so the parent gives every operation a time
// limit and simply kills the worker if it does not finish.
//
// Rules this file enforces:
//   - The delivery folder name comes only from a strictly validated reference; file
//     names are generated here (photo-001.jpg ...), never taken from anywhere.
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
  PHOTO_FILE_PATTERN,
  assertDeliveryFolderName,
  assertPhotoFileName,
  classifyRoot,
  resolveInsideRoot
} = require('./safe-path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

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
// storage-test.js already do - it is never set by any real caller.
function checkRoot(root, allowDriveLetter, platform) {
  const info = classifyRoot(root, platform);
  if (!info.ok) throw new ArchiveError('BAD_ROOT', `the archive folder is not usable: ${info.reason}`);
  if (info.kind === 'drive-letter' && !allowDriveLetter) throw new ArchiveError('BAD_ROOT', 'a drive letter cannot be used by the Delivery Photos worker');
}

// Every filesystem call the worker makes on the configured root goes through
// here first, so the single most common real-world failure - the share is
// unplugged, unmounted, or the account has no permission to it - always comes
// back as a plain ArchiveError with a stable code, never a raw Node ENOENT/EACCES
// exception (which would carry a real filesystem path and an unpredictable shape).
async function requireRoot(root) {
  let stats;
  try {
    stats = await fs.lstat(root);
  } catch (err) {
    if (err.code === 'ENOENT') throw new ArchiveError('ROOT_NOT_FOUND', 'the archive folder does not exist, or the network drive is not reachable right now');
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new ArchiveError('ROOT_DENIED', 'this account does not have permission to open the archive folder');
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
async function probeRoot({ root, allowDriveLetter = false, platform }) {
  checkRoot(root, allowDriveLetter, platform);
  await requireRoot(root);
  const space = await fsOps.getFreeSpace(root);
  return { ok: true, freeBytes: space.ok ? space.freeBytes : null };
}

async function listPhotoFiles(folder) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !PHOTO_FILE_PATTERN.test(entry.name)) continue;
    const stats = await fs.lstat(nodePath.join(folder, entry.name));
    files.push({ name: entry.name, number: Number(/\d+/.exec(entry.name)[0]), size: stats.size });
  }
  return files;
}

// Files the Bridge wrote and then had to give up on (killed part-way) are removed
// at the start of the next job. Only names that match our own <uuid>.part pattern are touched.
async function sweepIncoming({ root, allowDriveLetter = false, platform }) {
  checkRoot(root, allowDriveLetter, platform);
  await requireRoot(root);
  const incoming = resolveInsideRoot(root, [INCOMING_DIR_NAME]);
  try {
    return { removed: (await fsOps.sweepTempFiles(incoming)).length };
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: 0 };
    throw err;
  }
}

// Files one photograph (already downloaded to the local spool) into <root>/<REFERENCE>/photo-NNN.jpg.
// `hooks.afterPublish` exists only so tests can simulate a crash right after the rename.
async function archivePhoto(params, hooks = {}) {
  const { root, reference, photoId, spoolPath, sizeBytes, sha256, allowDriveLetter = false, platform } = params;

  if (!UUID.test(String(photoId))) throw new ArchiveError('BAD_INPUT', 'invalid photograph id');
  if (!SHA256.test(String(sha256)) || !Number.isInteger(sizeBytes) || sizeBytes < 1) throw new ArchiveError('BAD_INPUT', 'invalid size or checksum');
  if (typeof spoolPath !== 'string' || !nodePath.isAbsolute(spoolPath)) throw new ArchiveError('BAD_INPUT', 'invalid local file');
  let folderName;
  try {
    folderName = assertDeliveryFolderName(reference);
  } catch (err) {
    // Re-thrown as our own error type: every failure this module raises is an
    // ArchiveError, never an internal detail of the safe-path module.
    throw new ArchiveError('BAD_REFERENCE', err.message);
  }

  checkRoot(root, allowDriveLetter, platform);
  await requireRoot(root);

  const data = await fs.readFile(spoolPath);
  if (data.length !== sizeBytes || fsOps.sha256OfBuffer(data) !== sha256) {
    throw new ArchiveError('SPOOL_MISMATCH', 'the downloaded file does not match its checksum');
  }

  const incoming = resolveInsideRoot(root, [INCOMING_DIR_NAME]);
  await ensureDirectory(incoming);
  await fsOps.sweepTempFiles(incoming);

  const folder = resolveInsideRoot(root, [folderName]);
  await ensureDirectory(folder);

  // A crash after the rename but before the report leaves the file already in place: reuse it.
  const existing = await listPhotoFiles(folder);
  for (const file of existing) {
    if (file.size !== sizeBytes) continue;
    const check = await fsOps.verifyFile(nodePath.join(folder, file.name), { size: sizeBytes, sha256 });
    if (check.ok) return { storagePath: `${folderName}/${file.name}`, adopted: true, sizeBytes, sha256 };
  }

  let number = existing.reduce((highest, file) => Math.max(highest, file.number), 0) + 1;
  for (let attempt = 0; attempt < 5; attempt++, number++) {
    const name = `photo-${String(number).padStart(3, '0')}.jpg`;
    assertPhotoFileName(name);
    let finalPath;
    try {
      ({ finalPath } = await fsOps.publishNewFile({ tempDir: incoming, finalDir: folder, finalName: name, data }));
    } catch (err) {
      if (err instanceof fsOps.AlreadyExistsError) continue; // someone created that name meanwhile: take the next number
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

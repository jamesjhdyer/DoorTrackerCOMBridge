'use strict';

// Filesystem primitives for the Delivery Photos worker. These are the ONLY functions
// that create, rename or delete files in the archive, so the safety rules live
// here once:
//
//   - A photograph is written to a temporary file first and only becomes
//     visible under its final name through a single rename. A crash or a lost
//     connection can therefore leave a stray *.part file, never a half-written
//     photograph.
//   - An existing file is never overwritten. (On Windows a plain rename WOULD
//     silently replace the target, so the target is checked first; the Bridge
//     is the only writer, which keeps that check-then-rename window closed in
//     practice.)
//   - Only files this code created (or whose name matches our own temp-file
//     pattern) are ever deleted, and only individually - never a recursive
//     delete.
//   - "Written" is not "stored": callers must read the file back and compare
//     size and SHA-256 with verifyFile() before treating it as filed.

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const nodePath = require('node:path');
const { TEMP_FILE_PATTERN, checkSegment, UnsafePathError } = require('./safe-path');

class AlreadyExistsError extends Error {
  constructor(target) {
    super(`refusing to overwrite an existing file: ${target}`);
    this.name = 'AlreadyExistsError';
    this.code = 'EEXIST_REFUSED';
  }
}

function sha256OfBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Streams the file, so a large photograph never has to fit in memory.
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size }));
  });
}

// EBUSY/EPERM on a rename or delete is very often a virus scanner or backup
// agent holding the file for a moment, so those two are retried briefly.
// Anything else (missing folder, access denied, share gone) fails at once.
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM']);

async function withRetry(operation, { attempts = 4, baseDelayMs = 250 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (!RETRYABLE_CODES.has(err.code) || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastError;
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (err) {
    // Only "definitely not there" counts as absent. Any other error (share
    // unreachable, access denied) must not be mistaken for "safe to write".
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// FileHandle.write() may write less than asked; loop until everything is out.
async function writeFully(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten <= 0) throw new Error('write made no progress');
    offset += bytesWritten;
  }
}

// Step 1 of a save: create <tempDir>/<uuid>.part exclusively ("wx" fails if
// the name exists), write all bytes, ask the server to flush them (fsync ->
// FlushFileBuffers -> SMB flush), close, and confirm the size on disk.
// `hooks.afterPartialWrite` exists only so tests can simulate a crash halfway.
async function writeTempFile({ tempDir, data, hooks = {} }) {
  const tempPath = nodePath.join(tempDir, `${randomUUID()}.part`);
  let created = false;
  try {
    const handle = await fs.open(tempPath, 'wx');
    created = true;
    try {
      const half = Math.floor(data.length / 2);
      await writeFully(handle, data.subarray(0, half), 0);
      if (hooks.afterPartialWrite) await hooks.afterPartialWrite();
      await writeFully(handle, data.subarray(half), half);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const written = await fs.stat(tempPath);
    if (written.size !== data.length) {
      throw new Error(`temporary file is ${written.size} bytes, expected ${data.length}`);
    }
    return tempPath;
  } catch (err) {
    if (created) await fs.unlink(tempPath).catch(() => {}); // our own temp file, nothing else
    throw err;
  }
}

// Step 2 of a save: give the finished temp file its final name. Refuses to
// replace anything. On any failure the temp file this call was handed is
// removed, so nothing is left behind.
async function publishTempFile({ tempPath, finalDir, finalName }) {
  const problem = checkSegment(finalName);
  if (problem) {
    await fs.unlink(tempPath).catch(() => {});
    throw new UnsafePathError(`final name ${JSON.stringify(finalName)} rejected: ${problem}`);
  }
  const finalPath = nodePath.join(finalDir, finalName);
  try {
    if (await pathExists(finalPath)) throw new AlreadyExistsError(finalPath);
    await withRetry(() => fs.rename(tempPath, finalPath));
    return finalPath;
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

// Both steps in one call - what the real Bridge will use per photograph.
async function publishNewFile({ tempDir, finalDir, finalName, data, hooks }) {
  const problem = checkSegment(finalName);
  if (problem) throw new UnsafePathError(`final name ${JSON.stringify(finalName)} rejected: ${problem}`);
  const tempPath = await writeTempFile({ tempDir, data, hooks });
  const finalPath = await publishTempFile({ tempPath, finalDir, finalName });
  return { tempPath, finalPath };
}

// Reads the file back through a fresh handle and compares size + SHA-256.
async function verifyFile(filePath, expected) {
  const { sha256, size } = await sha256OfFile(filePath);
  const problems = [];
  if (size !== expected.size) problems.push(`size ${size} does not match expected ${expected.size}`);
  if (sha256 !== expected.sha256) problems.push('SHA-256 does not match');
  return { ok: problems.length === 0, size, sha256, problems };
}

// Removes leftover *.part files (a crash between "write" and "rename"). Only
// regular files whose name matches our own UUID.part pattern are touched.
async function sweepTempFiles(tempDir) {
  const removed = [];
  const entries = await fs.readdir(tempDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !TEMP_FILE_PATTERN.test(entry.name)) continue;
    await withRetry(() => fs.unlink(nodePath.join(tempDir, entry.name)));
    removed.push(entry.name);
  }
  return removed;
}

// Free space as seen by the account running the program (quotas included).
// fs.statfs needs Node 18.15+, and not every share answers it, so "unknown" is
// a normal, reported outcome - never a silent pass.
async function getFreeSpace(directory) {
  if (typeof fs.statfs !== 'function') {
    return { ok: false, error: 'fs.statfs is not available in this Node.js version' };
  }
  try {
    const stats = await fs.statfs(directory);
    const blockSize = Number(stats.bsize);
    return {
      ok: true,
      freeBytes: Number(stats.bavail) * blockSize,
      totalBytes: Number(stats.blocks) * blockSize
    };
  } catch (err) {
    return { ok: false, error: `${err.code || err.name}: ${err.message}` };
  }
}

module.exports = {
  AlreadyExistsError,
  sha256OfBuffer,
  sha256OfFile,
  withRetry,
  pathExists,
  writeTempFile,
  publishTempFile,
  publishNewFile,
  verifyFile,
  sweepTempFiles,
  getFreeSpace
};

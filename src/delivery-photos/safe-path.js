'use strict';

// Path and file-name safety for the Delivery Photos worker.
//
// Everything in this file is PURE - it never touches the filesystem - and it
// always applies WINDOWS naming rules, whichever operating system is running
// the code, because the files end up on a Windows network share (and the same
// code is exercised from a Mac during development).
//
// The rule that keeps the archive safe: no text that came from a URL, a
// request body, a spreadsheet cell or an API response is ever used as a path.
// A folder or file name must first pass one of the strict allow-lists below,
// and every final path is then re-checked to sit inside the configured
// photograph root. The two checks are deliberately redundant.

const nodePath = require('node:path');

class UnsafePathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const MAX_SEGMENT_LENGTH = 64;
// Windows tools still trip over MAX_PATH (260) in many places; keep headroom.
const MAX_FULL_PATH_LENGTH = 240;

// Device names Windows reserves in every folder, in any letter case, with or
// without an extension ("nul.jpg" still opens the NUL device).
const RESERVED_DEVICE_NAMES = new Set(
  ['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'].concat(
    Array.from({ length: 10 }, (_, i) => `COM${i}`),
    Array.from({ length: 10 }, (_, i) => `LPT${i}`)
  )
);

// ---- Allow-lists -----------------------------------------------------------
// Delivery folder: 5698-DELIV, 5698-P-DELIV, 5698-P2-DELIV, 5626-2-P3-DELIV.
// Upper-case only and single hyphens, so two spellings can never map to the
// same folder on a case-insensitive Windows filesystem.
const DELIVERY_FOLDER_PATTERN = /^[0-9A-Z]+(?:-[0-9A-Z]+)*-DELIV$/;
const PHOTO_FILE_PATTERN = /^photo-\d{3,6}\.jpg$/;
const TEMP_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;
// Names used only by the storage test (tools/storage-test.js).
const TEST_DIR_PATTERN = /^_storage-test-\d{8}-\d{6}-[0-9a-f]{8}$/;
const INCOMING_DIR_NAME = '.incoming';
const TEST_CANARY_NAME = '_canary.bin';
const TEST_MANIFEST_NAME = '_run-manifest.json';

// Returns null when `name` is acceptable as ONE path segment, otherwise a
// short human-readable reason. This is the generic gate; the typed
// validators below add an allow-list on top of it.
function checkSegment(name) {
  if (typeof name !== 'string') return 'not a string';
  if (name.length === 0) return 'empty';
  if (name.length > MAX_SEGMENT_LENGTH) return `longer than ${MAX_SEGMENT_LENGTH} characters`;
  if (name === '.' || name === '..') return 'relative path component';
  if (!/^[\x20-\x7e]+$/.test(name)) return 'contains a control or non-ASCII character';
  if (/[\\/]/.test(name)) return 'contains a path separator';
  if (/[:*?"<>|]/.test(name)) return 'contains a character Windows forbids in names (: * ? " < > |)';
  if (name !== name.trim()) return 'has leading or trailing whitespace';
  if (/[. ]$/.test(name)) return 'ends with a dot or space (Windows silently strips these)';
  if (/~\d/.test(name)) return 'looks like a Windows 8.3 short-name alias';
  const base = name.split('.')[0].toUpperCase();
  if (RESERVED_DEVICE_NAMES.has(base)) return `reserved Windows device name (${base})`;
  return null;
}

function assertMatches(kind, name, pattern) {
  const problem = checkSegment(name);
  if (problem) throw new UnsafePathError(`${kind} ${JSON.stringify(name)} rejected: ${problem}`);
  if (!pattern.test(name)) {
    throw new UnsafePathError(`${kind} ${JSON.stringify(name)} rejected: does not match the allowed format`);
  }
  return name;
}

const assertDeliveryFolderName = (name) => assertMatches('delivery folder', name, DELIVERY_FOLDER_PATTERN);
const assertPhotoFileName = (name) => assertMatches('photo file name', name, PHOTO_FILE_PATTERN);
const assertTempFileName = (name) => assertMatches('temporary file name', name, TEMP_FILE_PATTERN);
const assertTestDirName = (name) => assertMatches('test directory', name, TEST_DIR_PATTERN);

// Judges the CONFIGURED photograph root (operator-supplied, so this catches
// mistakes rather than attacks): it must be an absolute UNC path on Windows,
// and must be a folder below a share, never the top of the share or a drive.
// Drive letters are classified separately because a mapped drive letter exists
// only inside the Windows logon session that created it - a scheduled task or
// service running as another account cannot see it.
function classifyRoot(root, platform = process.platform) {
  const bad = (reason) => ({ ok: false, kind: 'invalid', reason });

  if (typeof root !== 'string' || root.length === 0) return bad('the photograph root is empty');
  if (root !== root.trim()) return bad('the photograph root has leading or trailing spaces');
  if (/[\x00-\x1f\x7f]/.test(root)) return bad('the photograph root contains control characters');

  const parts = root.split(/[\\/]+/);
  if (parts.includes('.') || parts.includes('..')) return bad('the photograph root must not contain "." or ".." components');
  if (parts.some((p) => p.length > 0 && /[. ]$/.test(p))) return bad('a root folder name ends with a dot or space');

  if (platform === 'win32') {
    if (/^\\\\[?.]\\/.test(root)) return bad('device-namespace paths (\\\\?\\ and \\\\.\\) are not accepted');
    if (/^\/\//.test(root)) return bad('use backslashes, for example \\\\server\\share\\Delivery Photographs');

    const unc = /^\\\\([^\\\/:*?"<>|]+)\\([^\\\/:*?"<>|]+)((?:\\[^\\\/:*?"<>|]+)*)\\?$/.exec(root);
    if (unc) {
      if (!unc[3]) {
        return bad('the root is the top of the share; use a sub-folder such as \\\\server\\share\\Delivery Photographs');
      }
      return { ok: true, kind: 'unc', server: unc[1], share: unc[2], rest: unc[3] };
    }

    const drive = /^([A-Za-z]):\\(.*)$/.exec(root);
    if (drive) {
      if (!drive[2].replace(/\\+$/, '')) return bad('the root is a drive root; use a sub-folder');
      return { ok: true, kind: 'drive-letter', drive: drive[1].toUpperCase() };
    }

    return bad('the root must be an absolute UNC path such as \\\\server\\share\\Delivery Photographs');
  }

  // macOS / Linux: development only.
  if (/^(\\\\|\/\/)/.test(root)) return bad('UNC paths only work when running on Windows');
  if (!nodePath.posix.isAbsolute(root)) return bad('the root must be an absolute path');
  return { ok: true, kind: 'posix-dev' };
}

// Cleans up a folder path typed or pasted by a person: surrounding quotes and
// a trailing backslash are not part of the folder name (and a trailing
// backslash before a closing quote silently corrupts a Windows command line).
function normalizeRootInput(raw) {
  if (typeof raw !== 'string') return raw;
  let value = raw.trim();
  const quoted = value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'"));
  if (quoted) value = value.slice(1, -1).trim();
  while (value.length > 3 && /[\\/]$/.test(value)) value = value.slice(0, -1);
  return value;
}

function defaultPathModule() {
  return process.platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

// Builds root + segments and proves the result is still inside root. Every
// segment goes through checkSegment(), which already rules out separators and
// "..", so the containment test below can never fail for a safe input - it
// exists to catch a future bug in the code above, not to be relied on.
function resolveInsideRoot(root, segments, pathModule = defaultPathModule()) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new UnsafePathError('at least one path segment is required');
  }

  const rootResolved = pathModule.resolve(root);
  let current = rootResolved;
  for (const segment of segments) {
    const problem = checkSegment(segment);
    if (problem) throw new UnsafePathError(`path segment ${JSON.stringify(segment)} rejected: ${problem}`);
    current = pathModule.join(current, segment);
  }

  const rel = pathModule.relative(rootResolved, current);
  const first = rel.split(/[\\/]/)[0];
  if (rel === '' || first === '..' || pathModule.isAbsolute(rel)) {
    throw new UnsafePathError('resolved path is outside the photograph root');
  }
  if (current.length > MAX_FULL_PATH_LENGTH) {
    throw new UnsafePathError(`resolved path is longer than ${MAX_FULL_PATH_LENGTH} characters`);
  }
  return current;
}

module.exports = {
  UnsafePathError,
  MAX_SEGMENT_LENGTH,
  MAX_FULL_PATH_LENGTH,
  DELIVERY_FOLDER_PATTERN,
  PHOTO_FILE_PATTERN,
  TEMP_FILE_PATTERN,
  TEST_DIR_PATTERN,
  INCOMING_DIR_NAME,
  TEST_CANARY_NAME,
  TEST_MANIFEST_NAME,
  checkSegment,
  assertDeliveryFolderName,
  assertPhotoFileName,
  assertTempFileName,
  assertTestDirName,
  classifyRoot,
  normalizeRootInput,
  resolveInsideRoot
};

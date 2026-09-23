'use strict';

// Pure logic, no real filesystem I/O - classifyRoot() takes `platform` as a
// parameter specifically so these rules can be proven correct for Windows
// from any development machine, not just when the test happens to be
// running on a real Windows box. This is the single place the production
// rule ("the archive root must be a UNC path - never a drive letter, never
// anything else") is proven directly; every other test file that opts a
// real local temp folder in via LOCAL_TEST_ROOT_OPTIONS (see helpers.js) is
// trusting THIS file to have already nailed down what "drive letter" and
// "UNC" actually mean on Windows.

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyRoot, checkSegment, normalizeRootInput, assertDeliveryFolderName, UnsafePathError } = require('./safe-path');

const WIN = 'win32';

test('a proper UNC path, at least one folder below the share, is accepted', () => {
  const result = classifyRoot('\\\\SERVER\\Share\\Delivery Photographs', WIN);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'unc');
  assert.equal(result.server, 'SERVER');
  assert.equal(result.share, 'Share');
});

test('the bare top of a share, with no sub-folder, is refused - never just \\\\server\\share', () => {
  for (const bare of ['\\\\SERVER\\Share', '\\\\SERVER\\Share\\']) {
    const result = classifyRoot(bare, WIN);
    assert.equal(result.ok, false, bare);
    assert.match(result.reason, /top of the share/);
  }
});

test('EVERY drive letter is classified as "drive-letter", not accepted as a network path - this is what the production rule rejects', () => {
  // Explicitly including D:\ - what GitHub Actions' own Windows runners use
  // for the checkout/temp folders, which is exactly what surfaced this gap.
  for (const letter of ['C', 'D', 'S', 'Z', 'c', 'z']) {
    const result = classifyRoot(`${letter}:\\Photos`, WIN);
    assert.equal(result.ok, true, `${letter}: should classify, not error, so callers can make an explicit accept/reject decision`);
    assert.equal(result.kind, 'drive-letter');
    assert.equal(result.drive, letter.toUpperCase());
  }
});

test('a bare drive root, with no sub-folder, is refused even as a drive letter', () => {
  for (const bare of ['D:\\', 'D:']) {
    assert.equal(classifyRoot(bare, WIN).ok, false, bare);
  }
});

test('a relative path is refused outright - never classified as anything usable', () => {
  for (const relative of ['relative\\path', 'Photos', '.\\Photos', 'a\\b\\c']) {
    const result = classifyRoot(relative, WIN);
    assert.equal(result.ok, false, relative);
    assert.doesNotMatch(result.reason, /drive letter/, 'must be refused for being relative, not mistaken for a drive letter');
  }
});

test('forward slashes, device-namespace paths, "." and ".." components, and control characters are all refused on Windows', () => {
  for (const bad of ['//SERVER/Share/Photos', '\\\\?\\C:\\Photos', '\\\\.\\C:\\Photos', '\\\\SERVER\\Share\\.\\Photos', '\\\\SERVER\\Share\\..\\Photos', '\\\\SERVER\\Share\\Pho\x00tos']) {
    assert.equal(classifyRoot(bad, WIN).ok, false, bad);
  }
});

test('empty, whitespace-padded, or non-string roots are refused', () => {
  for (const bad of ['', '   ', ' \\\\SERVER\\Share\\Photos', '\\\\SERVER\\Share\\Photos ', null, undefined, 42]) {
    assert.equal(classifyRoot(bad, WIN).ok, false, JSON.stringify(bad));
  }
});

test('on macOS/Linux (development only), a plain absolute path is accepted but a UNC-shaped one is refused with a clear reason', () => {
  for (const plat of ['darwin', 'linux']) {
    assert.equal(classifyRoot('/Users/dev/scratch/share', plat).kind, 'posix-dev');
    const uncOnPosix = classifyRoot('\\\\SERVER\\Share\\Photos', plat);
    assert.equal(uncOnPosix.ok, false);
    assert.match(uncOnPosix.reason, /only work when running on Windows/);
    assert.equal(classifyRoot('relative/path', plat).ok, false, 'still requires an absolute path even in dev mode');
  }
});

test('normalizeRootInput strips a wrapping quote pair and a trailing separator, nothing else', () => {
  assert.equal(normalizeRootInput('"\\\\SERVER\\Share\\Photos\\"'), '\\\\SERVER\\Share\\Photos');
  assert.equal(normalizeRootInput("'\\\\SERVER\\Share\\Photos'"), '\\\\SERVER\\Share\\Photos');
  assert.equal(normalizeRootInput('\\\\SERVER\\Share\\Photos\\'), '\\\\SERVER\\Share\\Photos');
  assert.equal(normalizeRootInput('  \\\\SERVER\\Share\\Photos  '), '\\\\SERVER\\Share\\Photos');
});

test('checkSegment rejects path separators, traversal, reserved Windows device names, and trailing dots/spaces', () => {
  for (const bad of ['a/b', 'a\\b', '..', '.', 'CON', 'con.jpg', 'NUL', 'COM1', 'LPT9', 'trailing.', 'trailing ', ' leading']) {
    assert.ok(checkSegment(bad), `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assert.equal(checkSegment('CONSOLE'), null, 'a name merely starting with a reserved word is fine - only the exact basename is reserved');
  assert.equal(checkSegment('5698-DELIV'), null);
});

test('assertDeliveryFolderName accepts only the exact grammar, uppercase, single hyphens', () => {
  for (const good of ['5698-DELIV', '5698-P-DELIV', '5698-P2-DELIV', '5626-2-P3-DELIV']) {
    assert.equal(assertDeliveryFolderName(good), good);
  }
  for (const bad of ['5698-deliv', '../5698-DELIV', '5698--DELIV', '']) {
    assert.throws(() => assertDeliveryFolderName(bad), UnsafePathError);
  }
});

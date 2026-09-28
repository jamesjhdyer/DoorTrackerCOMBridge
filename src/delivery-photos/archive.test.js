'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const nodePath = require('node:path');
const { randomUUID } = require('node:crypto');

const archive = require('./archive');
const fsOps = require('./fs-ops');
const { makeEnv, jpeg } = require('./helpers');

async function writeSpool(env, bytes, name = `${randomUUID()}.jpg`) {
  const spoolPath = nodePath.join(env.spool, name);
  await fsp.mkdir(env.spool, { recursive: true });
  await fsp.writeFile(spoolPath, bytes);
  return spoolPath;
}

// Every test below files onto env.share, a real local temp folder. On a real
// Windows machine (including GitHub Actions' own Windows runners) that makes
// it a genuine drive-letter path - which the production rule now accepts
// directly (see the "production Windows path rules" tests below), so no
// special test-only opt-in is needed here any more.
function params(env, overrides = {}) {
  const bytes = overrides.bytes || jpeg('archive-test');
  return {
    root: env.share,
    reference: '5698-DELIV',
    photoId: randomUUID(),
    spoolPath: overrides.spoolPath,
    sizeBytes: bytes.length,
    sha256: fsOps.sha256OfBuffer(bytes),
    ...overrides
  };
}

test('probeRoot reports ok and free space for a real folder, and a plain error for a missing one', async () => {
  const env = makeEnv();
  try {
    const ok = await archive.probeRoot({ root: env.share });
    assert.equal(ok.ok, true);
    assert.ok(typeof ok.freeBytes === 'number' || ok.freeBytes === null);

    await assert.rejects(archive.probeRoot({ root: nodePath.join(env.share, 'does-not-exist') }), archive.ArchiveError);
  } finally {
    env.cleanup();
  }
});

test('probeRoot refuses a root with an invalid shape (relative path)', async () => {
  await assert.rejects(archive.probeRoot({ root: 'relative/path' }), archive.ArchiveError);
});

// Every path shape named explicitly, individually, rather than trusting one
// example to stand in for the rest. The Delivery Photos worker always runs
// forked from the interactive, logged-in COM Bridge app (never a Windows
// service or a scheduled task under a different account), so it inherits
// that same user's own drive mappings exactly as Explorer does - both a UNC
// path and a mapped drive letter are legitimate production archive roots.
// What must never weaken is the SHAPE check: relative paths are still
// refused outright, and only for that reason.
test('production Windows path rules: UNC and every drive letter are accepted by checkRoot; a relative path is refused', async () => {
  const unc = '\\\\SERVER\\Share\\Delivery Photographs';
  await assert.rejects(archive.probeRoot({ root: unc, platform: 'win32' }), (err) => {
    assert.ok(err instanceof archive.ArchiveError);
    // Fails only because \\SERVER doesn't really exist on the machine running
    // this test, never because the UNC shape itself was refused.
    assert.doesNotMatch(err.message, /is not usable/, `must pass the shape check - got: ${err.message}`);
    return true;
  });

  // This is the exact shape of the bug that once broke the GitHub Actions
  // Windows build: that runner's own temp/checkout folders live on a D:\
  // drive, so a real local test folder is a genuine drive-letter path there.
  const driveLetterRoot = 'D:\\a\\DoorTrackerCOMBridge\\DoorTrackerCOMBridge\\Temp\\dp-test-abc123\\share';
  await assert.rejects(archive.probeRoot({ root: driveLetterRoot, platform: 'win32' }), (err) => {
    assert.ok(err instanceof archive.ArchiveError);
    assert.doesNotMatch(err.message, /is not usable/, `must pass the shape check - got: ${err.message}`);
    return true;
  });

  await assert.rejects(archive.probeRoot({ root: 'relative\\path', platform: 'win32' }), (err) => {
    assert.ok(err instanceof archive.ArchiveError);
    assert.match(err.message, /is not usable/, `a relative path must still be refused for its shape - got: ${err.message}`);
    return true;
  });
});

test('a mapped drive letter that is not reachable reports a clear, specific message naming the drive', async () => {
  await assert.rejects(archive.probeRoot({ root: 'S:\\Delivery Photographs', platform: 'win32' }), (err) => {
    assert.ok(err instanceof archive.ArchiveError);
    assert.match(err.message, /Network drive unavailable — waiting for S:/, `must name the drive it is waiting for - got: ${err.message}`);
    return true;
  });
});

test('archivePhoto files the first photograph as photo-001.jpg and verifies it by reading it back', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('one', 4000);
    const spoolPath = await writeSpool(env, bytes);
    const result = await archive.archivePhoto(params(env, { bytes, spoolPath }));
    assert.equal(result.storagePath, '5698-DELIV/photo-001.jpg');
    assert.equal(result.adopted, false);
    const onDisk = fs.readFileSync(nodePath.join(env.share, '5698-DELIV', 'photo-001.jpg'));
    assert.ok(onDisk.equals(bytes));
  } finally {
    env.cleanup();
  }
});

test('a second photograph for the same delivery is numbered photo-002.jpg', async () => {
  const env = makeEnv();
  try {
    const first = jpeg('first', 3000);
    await archive.archivePhoto(params(env, { bytes: first, spoolPath: await writeSpool(env, first) }));
    const second = jpeg('second', 3000);
    const result = await archive.archivePhoto(params(env, { bytes: second, spoolPath: await writeSpool(env, second) }));
    assert.equal(result.storagePath, '5698-DELIV/photo-002.jpg');
  } finally {
    env.cleanup();
  }
});

test('re-archiving the identical photograph after a crash adopts the file already on the drive instead of duplicating it', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('retry-me', 3500);
    const p = params(env, { bytes, spoolPath: await writeSpool(env, bytes) });
    const first = await archive.archivePhoto(p);

    // Simulate the Bridge crashing after the rename and before it told the website: retried with a fresh spool copy.
    const retryParams = { ...p, photoId: p.photoId, spoolPath: await writeSpool(env, bytes) };
    const second = await archive.archivePhoto(retryParams);

    assert.equal(second.storagePath, first.storagePath);
    assert.equal(second.adopted, true);
    assert.deepEqual(fs.readdirSync(nodePath.join(env.share, '5698-DELIV')).filter((n) => n.startsWith('photo-')), ['photo-001.jpg'], 'must not duplicate the file');
  } finally {
    env.cleanup();
  }
});

test('a different photograph that happens to be the same size as an existing file is NOT adopted, and gets its own number', async () => {
  const env = makeEnv();
  try {
    const sameSize = 3000;
    const a = jpeg('photo-a', sameSize);
    await archive.archivePhoto(params(env, { bytes: a, spoolPath: await writeSpool(env, a) }));
    const b = jpeg('photo-b-totally-different-content', sameSize);
    const result = await archive.archivePhoto(params(env, { bytes: b, spoolPath: await writeSpool(env, b) }));
    assert.equal(result.adopted, false);
    assert.equal(result.storagePath, '5698-DELIV/photo-002.jpg');
  } finally {
    env.cleanup();
  }
});

test('a crash right after the rename (afterPublish hook) leaves the file safely in place for the next attempt to adopt', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('crash-after-rename', 2500);
    const p = params(env, { bytes, spoolPath: await writeSpool(env, bytes) });
    let crashed = false;
    await assert.rejects(
      archive.archivePhoto(p, {
        afterPublish: () => {
          crashed = true;
          throw new Error('INJECTED_CRASH_AFTER_RENAME');
        }
      }),
      /INJECTED_CRASH_AFTER_RENAME/
    );
    assert.equal(crashed, true);
    // The file is really on disk even though the operation "crashed" before verifying/returning.
    assert.ok(fs.readFileSync(nodePath.join(env.share, '5698-DELIV', 'photo-001.jpg')).equals(bytes));

    const retry = await archive.archivePhoto({ ...p, spoolPath: await writeSpool(env, bytes) });
    assert.equal(retry.adopted, true);
    assert.equal(retry.storagePath, '5698-DELIV/photo-001.jpg');
  } finally {
    env.cleanup();
  }
});

test('archivePhoto refuses a hostile delivery reference instead of writing anywhere', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('hostile', 1000);
    // Note: "CON-DELIV" is deliberately not in this list - Windows reserves the exact
    // basename CON, not names that merely start with it, and every delivery folder name
    // is required to end in "-DELIV" so it can never collide with a reserved device name.
    for (const reference of ['../../etc', '5698-DELIV/../../evil', '5698--DELIV', '', 'lowercase-deliv']) {
      await assert.rejects(
        archive.archivePhoto(params(env, { bytes, spoolPath: await writeSpool(env, bytes), reference })),
        archive.ArchiveError
      );
    }
    assert.deepEqual(fs.readdirSync(env.share), [], 'nothing must be created for a rejected reference');
  } finally {
    env.cleanup();
  }
});

test('archivePhoto refuses when the archive root itself does not exist (it is never created)', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('no-root', 1000);
    const missingRoot = nodePath.join(env.share, 'missing-share');
    await assert.rejects(
      archive.archivePhoto(params(env, { bytes, spoolPath: await writeSpool(env, bytes), root: missingRoot })),
      archive.ArchiveError
    );
  } finally {
    env.cleanup();
  }
});

test('archivePhoto detects a spool file that does not match its claimed checksum', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('tampered', 2000);
    const spoolPath = await writeSpool(env, bytes);
    await fsp.appendFile(spoolPath, Buffer.from([0]));
    await assert.rejects(archive.archivePhoto(params(env, { bytes, spoolPath })), archive.ArchiveError);
  } finally {
    env.cleanup();
  }
});

test('sweepIncoming removes only leftover .part files from a previous crash', async () => {
  const env = makeEnv();
  try {
    const incoming = nodePath.join(env.share, '.incoming');
    fs.mkdirSync(incoming, { recursive: true });
    fs.writeFileSync(nodePath.join(incoming, `${randomUUID()}.part`), 'leftover');
    fs.writeFileSync(nodePath.join(incoming, 'not-ours.txt'), 'leave me alone');
    const result = await archive.sweepIncoming({ root: env.share });
    assert.equal(result.removed, 1);
    assert.deepEqual(fs.readdirSync(incoming), ['not-ours.txt']);
  } finally {
    env.cleanup();
  }
});

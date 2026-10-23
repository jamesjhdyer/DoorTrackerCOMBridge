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
    baseOrder: '5698',
    photoRole: 'DELIV',
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

test('archivePhoto files the first photograph as <order>/001-DELIV.jpg and verifies it by reading it back', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('one', 4000);
    const spoolPath = await writeSpool(env, bytes);
    const result = await archive.archivePhoto(params(env, { bytes, spoolPath }));
    assert.equal(result.storagePath, '5698/001-DELIV.jpg');
    assert.equal(result.adopted, false);
    const onDisk = fs.readFileSync(nodePath.join(env.share, '5698', '001-DELIV.jpg'));
    assert.ok(onDisk.equals(bytes));
  } finally {
    env.cleanup();
  }
});

test('a second photograph for the same order is numbered 002', async () => {
  const env = makeEnv();
  try {
    const first = jpeg('first', 3000);
    await archive.archivePhoto(params(env, { bytes: first, spoolPath: await writeSpool(env, first) }));
    const second = jpeg('second', 3000);
    const result = await archive.archivePhoto(params(env, { bytes: second, spoolPath: await writeSpool(env, second) }));
    assert.equal(result.storagePath, '5698/002-DELIV.jpg');
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
    assert.deepEqual(fs.readdirSync(nodePath.join(env.share, '5698')), ['001-DELIV.jpg'], 'must not duplicate the file');
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
    assert.equal(result.storagePath, '5698/002-DELIV.jpg');
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
    assert.ok(fs.readFileSync(nodePath.join(env.share, '5698', '001-DELIV.jpg')).equals(bytes));

    const retry = await archive.archivePhoto({ ...p, spoolPath: await writeSpool(env, bytes) });
    assert.equal(retry.adopted, true);
    assert.equal(retry.storagePath, '5698/001-DELIV.jpg');
  } finally {
    env.cleanup();
  }
});

test('archivePhoto refuses a hostile or malformed base order instead of writing anywhere', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('hostile', 1000);
    for (const baseOrder of ['../../etc', '5698/../../evil', '5698\\..\\evil', '5698-DELIV', '5698-D-01', '5626--2', 'CON', 'NUL', '', '.', '..', undefined]) {
      await assert.rejects(archive.archivePhoto(params(env, { bytes, spoolPath: await writeSpool(env, bytes), baseOrder })), (err) => {
        assert.ok(err instanceof archive.ArchiveError);
        assert.equal(err.code, 'BAD_ORDER', `${JSON.stringify(baseOrder)}: ${err.message}`);
        return true;
      });
    }
    assert.deepEqual(fs.readdirSync(env.share), [], 'nothing must be created for a rejected order');
  } finally {
    env.cleanup();
  }
});

test('archivePhoto refuses any photo role other than DELIV, BENCH or IRN', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('bad-role', 1000);
    for (const photoRole of ['deliv', 'bench', 'OTHER', 'DELIV/../x', '', undefined, 'delivery']) {
      await assert.rejects(archive.archivePhoto(params(env, { bytes, spoolPath: await writeSpool(env, bytes), photoRole })), (err) => err instanceof archive.ArchiveError && err.code === 'BAD_ROLE');
    }
    assert.deepEqual(fs.readdirSync(env.share), []);
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

test('minFreeGb rejects an upload when free space is below the configured threshold, before anything is written', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('no-space', 1000);
    await assert.rejects(
      archive.archivePhoto(params(env, { bytes, spoolPath: await writeSpool(env, bytes), minFreeGb: 999999999 })),
      (err) => {
        assert.ok(err instanceof archive.ArchiveError);
        assert.equal(err.code, 'INSUFFICIENT_SPACE');
        assert.match(err.message, /GB free/);
        return true;
      }
    );
    assert.deepEqual(fs.readdirSync(env.share), [], 'nothing must be created when space is rejected');
  } finally {
    env.cleanup();
  }
});

test('minFreeGb does not block a normal upload when there is plenty of free space', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('plenty-of-space', 1000);
    const result = await archive.archivePhoto(params(env, { bytes, spoolPath: await writeSpool(env, bytes), minFreeGb: 0.0001 }));
    assert.equal(result.storagePath, '5698/001-DELIV.jpg');
  } finally {
    env.cleanup();
  }
});

test('minFreeGb of 0 (the default when not configured) never checks free space at all', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('no-check', 1000);
    // minFreeGb omitted entirely, exactly like every other test in this file -
    // must behave exactly as before this feature existed.
    const result = await archive.archivePhoto(params(env, { bytes, spoolPath: await writeSpool(env, bytes) }));
    assert.equal(result.storagePath, '5698/001-DELIV.jpg');
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

// ---- Order folders, role suffixes and numbering across the whole folder ----

let fileCounter = 0;
async function file(env, baseOrder, photoRole, label) {
  const bytes = jpeg(label || `${baseOrder}-${photoRole}-${++fileCounter}`, 2000 + (fileCounter % 500));
  return archive.archivePhoto(params(env, { bytes, spoolPath: await writeSpool(env, bytes), baseOrder, photoRole }));
}

function seed(env, folder, names) {
  fs.mkdirSync(nodePath.join(env.share, folder), { recursive: true });
  for (const name of names) fs.writeFileSync(nodePath.join(env.share, folder, name), `existing ${name}`);
}

const listing = (env, folder) => fs.readdirSync(nodePath.join(env.share, folder)).sort();

test('numbering continues across roles in one order folder: DELIV, then BENCH, then IRN, then DELIV again', async () => {
  const env = makeEnv();
  try {
    const paths = [];
    for (const role of ['DELIV', 'DELIV', 'BENCH', 'BENCH', 'IRN', 'DELIV', 'DELIV']) paths.push((await file(env, '5698', role)).storagePath);
    assert.deepEqual(paths, ['5698/001-DELIV.jpg', '5698/002-DELIV.jpg', '5698/003-BENCH.jpg', '5698/004-BENCH.jpg', '5698/005-IRN.jpg', '5698/006-DELIV.jpg', '5698/007-DELIV.jpg']);
  } finally {
    env.cleanup();
  }
});

test('given 001-DELIV, 002-BENCH and 003-IRN already there, the next photo of each role is 004', async () => {
  for (const role of ['DELIV', 'BENCH', 'IRN']) {
    const env = makeEnv();
    try {
      seed(env, '5698', ['001-DELIV.jpg', '002-BENCH.jpg', '003-IRN.jpg']);
      assert.equal((await file(env, '5698', role)).storagePath, `5698/004-${role}.jpg`);
    } finally {
      env.cleanup();
    }
  }
});

test('a call-off order folder (5626-2) is numbered the same way', async () => {
  const env = makeEnv();
  try {
    assert.equal((await file(env, '5626-2', 'DELIV')).storagePath, '5626-2/001-DELIV.jpg');
    assert.equal((await file(env, '5626-2', 'BENCH')).storagePath, '5626-2/002-BENCH.jpg');
    assert.equal((await file(env, '5626-2', 'IRN')).storagePath, '5626-2/003-IRN.jpg');
    assert.deepEqual(fs.readdirSync(env.share).filter((n) => n !== '.incoming'), ['5626-2']);
  } finally {
    env.cleanup();
  }
});

test('gaps are never reused: the next number is one past the highest, not a count of files', async () => {
  const env = makeEnv();
  try {
    seed(env, '5698', ['001-DELIV.jpg', '005-BENCH.jpg']);
    assert.equal((await file(env, '5698', 'IRN')).storagePath, '5698/006-IRN.jpg');
  } finally {
    env.cleanup();
  }
});

test('unrelated files in the order folder neither count nor get touched; numbers written by hand in any case do count', async () => {
  const env = makeEnv();
  try {
    seed(env, '5698', ['notes.txt', 'photo-001.jpg', 'Thumbs.db', 'IMG_1234.jpg', '007-bench.JPG']);
    fs.mkdirSync(nodePath.join(env.share, '5698', '099-subfolder.jpg')); // a folder, even one named like a photo, is not a photo
    assert.equal((await file(env, '5698', 'DELIV')).storagePath, '5698/008-DELIV.jpg');
    for (const name of ['notes.txt', 'photo-001.jpg', 'Thumbs.db', 'IMG_1234.jpg', '007-bench.JPG']) {
      assert.equal(fs.readFileSync(nodePath.join(env.share, '5698', name), 'utf8'), `existing ${name}`, `${name} left exactly as it was`);
    }
  } finally {
    env.cleanup();
  }
});

test('numbers beyond 009, 099 and 999 keep counting correctly', async () => {
  const env = makeEnv();
  try {
    seed(env, '5698', ['009-DELIV.jpg']);
    assert.equal((await file(env, '5698', 'BENCH')).storagePath, '5698/010-BENCH.jpg');
    seed(env, '5698', ['099-IRN.jpg']);
    assert.equal((await file(env, '5698', 'IRN')).storagePath, '5698/100-IRN.jpg');
    seed(env, '5698', ['999-DELIV.jpg']);
    assert.equal((await file(env, '5698', 'DELIV')).storagePath, '5698/1000-DELIV.jpg');
    assert.equal((await file(env, '5698', 'DELIV')).storagePath, '5698/1001-DELIV.jpg');
  } finally {
    env.cleanup();
  }
});

test('an existing photograph is never overwritten, whatever its role', async () => {
  const env = makeEnv();
  try {
    seed(env, '5698', ['001-DELIV.jpg', '002-BENCH.jpg', '003-IRN.jpg']);
    for (const role of ['DELIV', 'BENCH', 'IRN']) await file(env, '5698', role);
    for (const name of ['001-DELIV.jpg', '002-BENCH.jpg', '003-IRN.jpg']) {
      assert.equal(fs.readFileSync(nodePath.join(env.share, '5698', name), 'utf8'), `existing ${name}`);
    }
    assert.deepEqual(listing(env, '5698'), ['001-DELIV.jpg', '002-BENCH.jpg', '003-IRN.jpg', '004-DELIV.jpg', '005-BENCH.jpg', '006-IRN.jpg']);
  } finally {
    env.cleanup();
  }
});

test('retrying the same photograph (same id and bytes) does not consume another sequence number', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('retried-bench', 2600);
    const p = params(env, { bytes, spoolPath: await writeSpool(env, bytes), baseOrder: '5698', photoRole: 'BENCH' });
    seed(env, '5698', ['001-DELIV.jpg']);
    const first = await archive.archivePhoto(p);
    const again = await archive.archivePhoto({ ...p, spoolPath: await writeSpool(env, bytes) });
    const third = await archive.archivePhoto({ ...p, spoolPath: await writeSpool(env, bytes) });
    assert.equal(first.storagePath, '5698/002-BENCH.jpg');
    assert.deepEqual([again.storagePath, again.adopted, third.storagePath, third.adopted], ['5698/002-BENCH.jpg', true, '5698/002-BENCH.jpg', true]);
    assert.equal((await file(env, '5698', 'IRN')).storagePath, '5698/003-IRN.jpg', 'the next new photo still gets the very next number');
  } finally {
    env.cleanup();
  }
});

test('a retry is only matched against files of its own role', async () => {
  const env = makeEnv();
  try {
    const bytes = jpeg('same-bytes-two-roles', 2700);
    await archive.archivePhoto(params(env, { bytes, spoolPath: await writeSpool(env, bytes), photoRole: 'DELIV' }));
    const asBench = await archive.archivePhoto(params(env, { bytes, spoolPath: await writeSpool(env, bytes), photoRole: 'BENCH' }));
    assert.deepEqual([asBench.storagePath, asBench.adopted], ['5698/002-BENCH.jpg', false], 'a Bench upload is never reported as an existing -DELIV file');
  } finally {
    env.cleanup();
  }
});

test('the order folder is created when missing and reused when it already exists', async () => {
  const env = makeEnv();
  try {
    assert.equal(fs.existsSync(nodePath.join(env.share, '5698')), false);
    await file(env, '5698', 'DELIV');
    assert.equal(fs.statSync(nodePath.join(env.share, '5698')).isDirectory(), true);
    await file(env, '5698', 'BENCH');
    assert.deepEqual(listing(env, '5698'), ['001-DELIV.jpg', '002-BENCH.jpg']);
  } finally {
    env.cleanup();
  }
});

test('a file standing where the order folder should be is refused, never written into or replaced', async () => {
  const env = makeEnv();
  try {
    fs.writeFileSync(nodePath.join(env.share, '5698'), 'not a folder');
    await assert.rejects(file(env, '5698', 'DELIV'), (err) => err instanceof archive.ArchiveError && err.code === 'NOT_A_FOLDER');
    assert.equal(fs.readFileSync(nodePath.join(env.share, '5698'), 'utf8'), 'not a folder');
  } finally {
    env.cleanup();
  }
});

test('historical <ORDER>-DELIV folders are left completely alone; new photos go to the base order folder', async () => {
  const env = makeEnv();
  try {
    seed(env, '5698-DELIV', ['photo-001.jpg', 'photo-002.jpg']);
    seed(env, '5698-P2-DELIV', ['photo-001.jpg']);
    const before = (folder) => fs.readdirSync(nodePath.join(env.share, folder)).map((n) => [n, fs.statSync(nodePath.join(env.share, folder, n)).mtimeMs, fs.readFileSync(nodePath.join(env.share, folder, n), 'utf8')]);
    const snapshot = { a: before('5698-DELIV'), b: before('5698-P2-DELIV') };

    assert.equal((await file(env, '5698', 'DELIV')).storagePath, '5698/001-DELIV.jpg', 'numbering in the new folder is independent of the old one');
    assert.deepEqual(before('5698-DELIV'), snapshot.a);
    assert.deepEqual(before('5698-P2-DELIV'), snapshot.b);
    assert.deepEqual(fs.readdirSync(env.share).sort(), ['.incoming', '5698', '5698-DELIV', '5698-P2-DELIV']);
  } finally {
    env.cleanup();
  }
});

test('the specification examples, exactly', async () => {
  const env = makeEnv();
  try {
    // Delivery 5698-P2-DELIV, into a folder that already has 001-BENCH.jpg.
    seed(env, '5698', ['001-BENCH.jpg']);
    await file(env, '5698', 'DELIV');
    await file(env, '5698', 'DELIV');
    assert.deepEqual(listing(env, '5698'), ['001-BENCH.jpg', '002-DELIV.jpg', '003-DELIV.jpg']);

    // Bench 5626-2-D-07, into a folder that already has 001-DELIV.jpg.
    seed(env, '5626-2', ['001-DELIV.jpg']);
    await file(env, '5626-2', 'BENCH');
    await file(env, '5626-2', 'BENCH');
    assert.deepEqual(listing(env, '5626-2'), ['001-DELIV.jpg', '002-BENCH.jpg', '003-BENCH.jpg']);

  } finally {
    env.cleanup();
  }

  // Ironmongery 5626-2, into a folder that already has 001-DELIV and 002-BENCH: one photo.
  const irn = makeEnv();
  try {
    seed(irn, '5626-2', ['001-DELIV.jpg', '002-BENCH.jpg']);
    await file(irn, '5626-2', 'IRN');
    assert.deepEqual(listing(irn, '5626-2'), ['001-DELIV.jpg', '002-BENCH.jpg', '003-IRN.jpg']);
  } finally {
    irn.cleanup();
  }
});

'use strict';

// The iPad's offline queue (delivery-photos-web/offline-queue.js) - the very
// same file the iPad runs - against an in-memory IndexedDB (fake-indexeddb)
// and a scripted fake Photo Service. The real Windows server is exercised
// separately, in offline-sync.test.js and offline-browser.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');

const Queue = require(nodePath.join(__dirname, '..', '..', 'delivery-photos-web', 'offline-queue.js'));
const { parse } = require('./reference');
const PhotoRoles = require('./photo-roles');
const { jpeg } = require('./helpers');

const sha = (buf) => createHash('sha256').update(Buffer.from(buf)).digest('hex');
const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

function photos(n, label = 'p') {
  return Array.from({ length: n }, (_, i) => ({
    photoId: randomUUID(),
    bytes: toArrayBuffer(jpeg(`${label}-${i}`, 2000 + i)),
    width: 4032,
    height: 3024,
    capturedAt: `2026-10-14T09:${String(10 + i).padStart(2, '0')}:00.000Z`
  }));
}

function sessionFor(reference) {
  return { sessionId: randomUUID(), ...Queue.deliveryMetadata(parse(reference)) };
}

function roleSession(role, code) {
  const parsed = PhotoRoles.parseForRole(role, code);
  assert.equal(parsed.ok, true, parsed.reason);
  return { sessionId: randomUUID(), ...Queue.sessionMetadata(parsed) };
}

// A scripted Photo Service: records every call; `behaviour` can make it
// unreachable, revoke pairing, or reject specific photos.
function fakeService() {
  const svc = {
    reachable: true,
    paired: true,
    role: 'delivery', // what the PC says this iPad is paired as
    wrongRolePhotoIds: new Set(),
    rejectPhotoIds: new Set(),
    dropAfterUploads: Infinity, // go "unreachable" after this many successful uploads
    failComplete: false,
    uploads: [],
    completes: [],
    async checkService() {
      return { reachable: svc.reachable, paired: svc.reachable && svc.paired, role: svc.role };
    },
    async uploadPhoto({ role, code, photoId, bytes, sha256 }) {
      if (!svc.reachable) return { ok: false, unreachable: true, error: 'Could not reach the PC.' };
      if (!svc.paired) return { ok: false, needsPairing: true, error: 'This device is not paired.' };
      if (svc.uploads.length >= svc.dropAfterUploads) {
        svc.reachable = false;
        return { ok: false, unreachable: true, error: 'Could not reach the PC.' };
      }
      assert.equal(sha(bytes), sha256, 'the queued bytes must still match their checksum');
      if (svc.rejectPhotoIds.has(photoId)) return { ok: false, error: 'The network drive could not be reached.' };
      if (svc.wrongRolePhotoIds.has(photoId)) return { ok: false, wrongRole: true, error: 'This iPad is now paired for another role.' };
      svc.uploads.push({ role, code, photoId, sha256 });
      return { ok: true };
    },
    async completeSession(body) {
      if (!svc.reachable) return { ok: false, unreachable: true, error: 'Could not reach the PC.' };
      if (!svc.paired) return { ok: false, needsPairing: true, error: 'This device is not paired.' };
      if (svc.failComplete) return { ok: false, error: 'Could not record this delivery as complete.' };
      svc.completes.push(body);
      return { ok: true };
    }
  };
  return svc;
}

async function setup() {
  const indexedDB = new IDBFactory();
  const store = await Queue.openStore({ indexedDB });
  const service = fakeService();
  const engine = Queue.createSyncEngine({ store, api: service });
  return { indexedDB, store, service, engine };
}

// ---- storing ---------------------------------------------------------------

test('an offline session is saved to IndexedDB with its metadata and the exact photo bytes', async () => {
  const { store } = await setup();
  const session = sessionFor('5698-DELIV');
  const shots = photos(3);
  const record = await store.saveSession(session, shots);

  assert.equal(record.status, Queue.STATUS.PENDING);
  assert.equal(record.photoCount, 3);
  assert.equal(record.capturedAt, shots[0].capturedAt);
  assert.ok(record.createdAt);
  assert.equal(record.lastAttemptAt, '');
  assert.equal(record.attempts, 0);

  const stored = await store.getPhotos(session.sessionId);
  assert.deepEqual(stored.map((p) => p.photoId), shots.map((p) => p.photoId), 'kept in shooting order');
  for (let i = 0; i < shots.length; i++) {
    assert.ok(Buffer.from(stored[i].bytes).equals(Buffer.from(shots[i].bytes)), 'the same bytes, never re-encoded');
    assert.equal(stored[i].sha256, sha(shots[i].bytes));
    assert.equal(stored[i].sizeBytes, shots[i].bytes.byteLength);
    assert.equal(stored[i].capturedAt, shots[i].capturedAt);
    assert.equal(stored[i].uploaded, false);
  }
});

test('full and part delivery metadata are preserved', async () => {
  const { store } = await setup();
  await store.saveSession(sessionFor('5698-DELIV'), photos(1));
  await store.saveSession(sessionFor('5698-P-DELIV'), photos(1));
  await store.saveSession(sessionFor('5626-2-P3-DELIV'), photos(1));

  const sessions = await store.listSessions();
  assert.deepEqual(
    sessions.map((s) => [s.reference, s.orderNumber, s.deliveryType, s.partNo]),
    [
      ['5698-DELIV', '5698', 'Full Delivery', ''],
      ['5698-P-DELIV', '5698', 'Part Delivery', 1],
      ['5626-2-P3-DELIV', '5626-2', 'Part Delivery', 3]
    ]
  );
});

test('the records hold no pairing token, credentials or network paths', async () => {
  const { store } = await setup();
  const session = sessionFor('5698-DELIV');
  await store.saveSession(session, photos(1));
  const record = await store.getSession(session.sessionId);
  const [photo] = await store.getPhotos(session.sessionId);
  const keys = [...Object.keys(record), ...Object.keys(photo)];
  for (const key of keys) assert.doesNotMatch(key, /token|auth|password|secret|path|root|share|unc/i);
});

test('queued data survives a reload (a brand-new connection to the same database)', async () => {
  const { indexedDB, store } = await setup();
  const a = sessionFor('5698-DELIV');
  const b = sessionFor('5701-P2-DELIV');
  const shotsA = photos(2, 'a');
  await store.saveSession(a, shotsA);
  await store.saveSession(b, photos(3, 'b'));
  store.close();

  const reopened = await Queue.openStore({ indexedDB });
  const sessions = await reopened.listSessions();
  assert.deepEqual(sessions.map((s) => s.reference), ['5698-DELIV', '5701-P2-DELIV'], 'oldest first');
  const stored = await reopened.getPhotos(a.sessionId);
  assert.ok(Buffer.from(stored[1].bytes).equals(Buffer.from(shotsA[1].bytes)));
});

test('a photo with no data is refused, and nothing at all is saved for that session', async () => {
  const { store } = await setup();
  const session = sessionFor('5698-DELIV');
  const shots = photos(2);
  shots[1].bytes = new ArrayBuffer(0);
  await assert.rejects(store.saveSession(session, shots), /no data/);
  assert.deepEqual(await store.listSessions(), []);
});

test('photos already filed online are recorded without their bytes', async () => {
  const { store } = await setup();
  const session = sessionFor('5698-DELIV');
  const shots = photos(2);
  shots[0] = { ...shots[0], bytes: null, uploaded: true, sha256: sha(shots[0].bytes), sizeBytes: shots[0].bytes.byteLength };
  const record = await store.saveSession(session, shots);
  const stored = await store.getPhotos(session.sessionId);
  assert.equal(stored[0].uploaded, true);
  assert.equal(stored[0].bytes, null);
  assert.equal(stored[1].uploaded, false);
  assert.equal(record.totalBytes, shots[1].bytes.byteLength);
});

// ---- sending ---------------------------------------------------------------

test('Photo Service unreachable: nothing is sent and nothing changes', async () => {
  const { store, service, engine } = await setup();
  service.reachable = false;
  const session = sessionFor('5698-DELIV');
  await store.saveSession(session, photos(2));

  const result = await engine.syncAll();
  assert.equal(result.outcome, 'unreachable');
  assert.equal(service.uploads.length, 0);
  assert.equal((await store.getSession(session.sessionId)).status, Queue.STATUS.PENDING);
});

test('sending pending deliveries: every photo in order, then completion, then the local copy is removed', async () => {
  const { store, service, engine } = await setup();
  const a = sessionFor('5698-DELIV');
  const b = sessionFor('5698-P2-DELIV');
  const shotsA = photos(2, 'a');
  const shotsB = photos(3, 'b');
  await store.saveSession(a, shotsA);
  await store.saveSession(b, shotsB);

  const result = await engine.syncAll();
  assert.deepEqual(result, { outcome: 'done', sent: 2, failed: 0 });
  assert.deepEqual(service.uploads.map((u) => u.photoId), [...shotsA, ...shotsB].map((p) => p.photoId));
  assert.deepEqual(service.completes, [
    { sessionId: a.sessionId, role: 'delivery', code: '5698-DELIV', photosSaved: 2 },
    { sessionId: b.sessionId, role: 'delivery', code: '5698-P2-DELIV', photosSaved: 3 }
  ]);
  assert.deepEqual(await store.listSessions(), []);
  assert.deepEqual(await store.getPhotos(a.sessionId), []);
});

test('one failed photo: the session is NOT completed, stays queued, and the other session still goes', async () => {
  const { store, service, engine } = await setup();
  const bad = sessionFor('5698-DELIV');
  const good = sessionFor('5701-DELIV');
  const badShots = photos(3, 'bad');
  await store.saveSession(bad, badShots);
  await store.saveSession(good, photos(1, 'good'));
  service.rejectPhotoIds.add(badShots[1].photoId);

  const result = await engine.syncAll();
  assert.deepEqual(result, { outcome: 'done', sent: 1, failed: 1 });
  assert.deepEqual(service.completes.map((c) => c.code), ['5701-DELIV'], 'no completion for the failed session');

  const remaining = await store.listSessions();
  assert.deepEqual(remaining.map((s) => s.reference), ['5698-DELIV'], 'only the completed session was deleted');
  assert.equal(remaining[0].status, Queue.STATUS.FAILED);
  assert.match(remaining[0].lastError, /network drive/);
  assert.equal(remaining[0].attempts, 1);
  assert.ok(remaining[0].lastAttemptAt);
  const stored = await store.getPhotos(bad.sessionId);
  assert.deepEqual(stored.map((p) => p.uploaded), [true, false, true], 'the photos that did go through are remembered');
  assert.ok(stored.every((p) => p.bytes && p.bytes.byteLength > 0), 'no photo bytes are deleted before the session completes');

  // Retry once the problem is fixed: only the failed photo is sent again.
  service.rejectPhotoIds.clear();
  const before = service.uploads.length;
  const retry = await engine.syncAll({ onlySessionId: bad.sessionId });
  assert.equal(retry.outcome, 'done');
  assert.deepEqual(service.uploads.slice(before).map((u) => u.photoId), [badShots[1].photoId]);
  assert.deepEqual(await store.listSessions(), []);
});

test('connection lost part-way: back to waiting, nothing lost, and the next sync carries on where it stopped', async () => {
  const { store, service, engine } = await setup();
  const session = sessionFor('5698-DELIV');
  const shots = photos(4);
  await store.saveSession(session, shots);
  service.dropAfterUploads = 2;

  const first = await engine.syncAll();
  assert.equal(first.outcome, 'unreachable');
  const record = await store.getSession(session.sessionId);
  assert.equal(record.status, Queue.STATUS.PENDING);
  assert.equal(service.completes.length, 0);

  service.reachable = true;
  service.dropAfterUploads = Infinity;
  const second = await engine.syncAll();
  assert.equal(second.outcome, 'done');
  assert.deepEqual(service.uploads.map((u) => u.photoId), shots.map((p) => p.photoId), 'each photo sent exactly once in total');
  assert.equal(service.completes.length, 1);
});

test('completion not acknowledged: photos stay recorded as sent, and only the completion is retried', async () => {
  const { store, service, engine } = await setup();
  const session = sessionFor('5698-DELIV');
  await store.saveSession(session, photos(2));
  service.failComplete = true;

  const first = await engine.syncAll();
  assert.deepEqual(first, { outcome: 'done', sent: 0, failed: 1 });
  assert.equal((await store.getSession(session.sessionId)).status, Queue.STATUS.FAILED);
  assert.equal(service.uploads.length, 2);

  service.failComplete = false;
  await engine.syncAll();
  assert.equal(service.uploads.length, 2, 'no photo re-sent');
  assert.equal(service.completes.length, 1);
  assert.deepEqual(await store.listSessions(), []);
});

test('pairing revoked: sending stops, every queued photo is kept, and it all goes once paired again', async () => {
  const { store, service, engine } = await setup();
  const a = sessionFor('5698-DELIV');
  const b = sessionFor('5701-DELIV');
  await store.saveSession(a, photos(2, 'a'));
  await store.saveSession(b, photos(1, 'b'));
  service.paired = false;

  const result = await engine.syncAll();
  assert.equal(result.outcome, 'needs_pairing');
  assert.equal(service.uploads.length, 0);
  const sessions = await store.listSessions();
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.status === Queue.STATUS.NEEDS_PAIRING));
  assert.equal((await store.getPhotos(a.sessionId)).length, 2);

  service.paired = true; // re-paired
  const after = await engine.syncAll();
  assert.deepEqual(after, { outcome: 'done', sent: 2, failed: 0 });
  assert.deepEqual(await store.listSessions(), []);
});

test('pairing revoked in the middle of sending: stops at once and keeps the session', async () => {
  const { store, service, engine } = await setup();
  const session = sessionFor('5698-DELIV');
  await store.saveSession(session, photos(3));
  const realUpload = service.uploadPhoto;
  service.uploadPhoto = async (args) => {
    if (service.uploads.length === 1) service.paired = false;
    return realUpload(args);
  };

  const result = await engine.syncAll();
  assert.equal(result.outcome, 'needs_pairing');
  assert.equal((await store.getSession(session.sessionId)).status, Queue.STATUS.NEEDS_PAIRING);
  assert.equal((await store.getPhotos(session.sessionId)).length, 3);
  assert.equal(service.completes.length, 0);
});

test('overlapping sync requests share one run - nothing is sent twice', async () => {
  const { store, service, engine } = await setup();
  await store.saveSession(sessionFor('5698-DELIV'), photos(2));
  const [r1, r2, r3] = await Promise.all([engine.syncAll(), engine.syncAll(), engine.syncAll()]);
  assert.equal(r1, r2);
  assert.equal(r2, r3);
  assert.equal(service.uploads.length, 2);
  assert.equal(service.completes.length, 1);
});

test('another tab already sending (lock unavailable): this one does nothing', async () => {
  const indexedDB = new IDBFactory();
  const store = await Queue.openStore({ indexedDB });
  const service = fakeService();
  const engine = Queue.createSyncEngine({ store, api: service, withLock: async () => null });
  await store.saveSession(sessionFor('5698-DELIV'), photos(1));
  const result = await engine.syncAll();
  assert.equal(result.outcome, 'busy');
  assert.equal(service.uploads.length, 0);
});

test('progress is reported while sending (for "Sending 2 of 4...")', async () => {
  const indexedDB = new IDBFactory();
  const store = await Queue.openStore({ indexedDB });
  const updates = [];
  const engine = Queue.createSyncEngine({ store, api: fakeService(), onProgress: (u) => updates.push(u) });
  const session = sessionFor('5698-DELIV');
  await store.saveSession(session, photos(2));
  await engine.syncAll();
  assert.deepEqual(updates, [
    { sessionId: session.sessionId, reference: '5698-DELIV', sending: 1, total: 2 },
    { sessionId: session.sessionId, reference: '5698-DELIV', sending: 2, total: 2 },
    { sessionId: session.sessionId, reference: '5698-DELIV', completing: true },
    null
  ]);
});

// ---- when sending happens ---------------------------------------------------

function fakePage() {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  return { win, doc };
}

test('automatic sending runs on open, focus, becoming visible, back online, and back-forward restore', () => {
  const { win, doc } = fakePage();
  const reasons = [];
  const uninstall = Queue.installAutoSync({ win, doc, run: (r) => reasons.push(r), intervalMs: 0 });
  win.dispatchEvent(new Event('focus'));
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('online'));
  win.dispatchEvent(new Event('pageshow'));
  assert.deepEqual(reasons, ['open', 'focus', 'visible', 'online', 'pageshow']);

  uninstall();
  win.dispatchEvent(new Event('focus'));
  assert.equal(reasons.length, 5, 'nothing after uninstall');
});

test('nothing is attempted while the page is hidden (no promise of background uploads)', () => {
  const { win, doc } = fakePage();
  doc.visibilityState = 'hidden';
  const reasons = [];
  const uninstall = Queue.installAutoSync({ win, doc, run: (r) => reasons.push(r), intervalMs: 0 });
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('online'));
  assert.deepEqual(reasons, []);
  uninstall();
});

test('a gentle timer also retries while visible (changing Wi-Fi does not always fire "online")', async () => {
  const { win, doc } = fakePage();
  const reasons = [];
  const uninstall = Queue.installAutoSync({ win, doc, run: (r) => reasons.push(r), intervalMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 75));
  uninstall();
  assert.ok(reasons.filter((r) => r === 'timer').length >= 2, JSON.stringify(reasons));
});

test('reconnecting triggers a real send: auto-sync wired to the engine empties the queue once the service answers', async () => {
  const { store, service, engine } = await setup();
  await store.saveSession(sessionFor('5698-DELIV'), photos(1));
  service.reachable = false;
  const { win, doc } = fakePage();
  const runs = [];
  const uninstall = Queue.installAutoSync({ win, doc, run: () => runs.push(engine.syncAll()), intervalMs: 0 });
  assert.equal((await runs[0]).outcome, 'unreachable');

  service.reachable = true;
  win.dispatchEvent(new Event('online'));
  assert.equal((await runs[1]).outcome, 'done');
  assert.deepEqual(await store.listSessions(), []);
  uninstall();
});

// ---- storage space -----------------------------------------------------------

test('storage: limits come from the browser\'s own quota', () => {
  const GB = 1e9;
  const plenty = Queue.assessStorage({ usage: 1.2 * GB, quota: 6 * GB }, 50e6);
  assert.equal(plenty.known, true);
  assert.equal(plenty.availableBytes, 4.8 * GB);
  assert.equal(plenty.canStore, true);
  assert.equal(plenty.high, false);

  const tight = Queue.assessStorage({ usage: 5.98 * GB, quota: 6 * GB }, 50e6);
  assert.equal(tight.canStore, false, '50 MB of photos plus a margin does not fit in 20 MB');
  assert.match(tight.reason, /not enough storage/);
  assert.equal(tight.high, true);

  const high = Queue.assessStorage({ usage: 4.9 * GB, quota: 6 * GB }, 0);
  assert.equal(high.high, true, 'warned above 80%');
  assert.equal(high.canStore, true, 'but still allowed while there is real room');
});

test('storage: a browser that cannot report its quota never blocks saving', () => {
  for (const estimate of [null, {}, { usage: 5 }, { usage: 5, quota: 0 }]) {
    const space = Queue.assessStorage(estimate, 50e6);
    assert.equal(space.known, false);
    assert.equal(space.canStore, true);
    assert.equal(space.high, false);
  }
});

test('storage: refusing a new session never touches sessions already queued', async () => {
  const { store } = await setup();
  await store.saveSession(sessionFor('5698-DELIV'), photos(1));
  const space = Queue.assessStorage({ usage: 999, quota: 1000 }, 5000);
  assert.equal(space.canStore, false);
  assert.equal((await store.listSessions()).length, 1);
});

test('formatBytes reads naturally', () => {
  assert.equal(Queue.formatBytes(1.2e9), '1.2 GB');
  assert.equal(Queue.formatBytes(4.8e6), '4.8 MB');
  assert.equal(Queue.formatBytes(1500), '2 KB');
  assert.equal(Queue.formatBytes(null), 'unknown');
});

// ---- Photo roles in the queue ------------------------------------------------

test('Bench and Ironmongery sessions keep their role, original scanned value and base order, and survive a reload', async () => {
  const indexedDB = new IDBFactory();
  const first = await Queue.openStore({ indexedDB });
  await first.saveSession(roleSession('bench', '5698-D'), photos(4, 'bench'));
  await first.saveSession(roleSession('ironmongery', '5626-2'), photos(3, 'irn'));
  await first.saveSession(roleSession('delivery', '5698-P2-DELIV'), photos(5, 'deliv'));
  first.close();

  const reopened = await Queue.openStore({ indexedDB });
  const sessions = await reopened.listSessions();
  assert.deepEqual(
    sessions.map((s) => [s.role, s.code, s.baseOrder, s.photoCount, s.deliveryType, s.partNo]),
    [
      ['bench', '5698-D', '5698', 4, '', ''],
      ['ironmongery', '5626-2', '5626-2', 3, '', ''],
      ['delivery', '5698-P2-DELIV', '5698', 5, 'Part Delivery', 2]
    ]
  );
  for (const s of sessions) {
    assert.match(s.sessionId, /^[0-9a-f-]{36}$/);
    assert.ok(s.capturedAt);
    const stored = await reopened.getPhotos(s.sessionId);
    assert.equal(stored.length, s.photoCount);
    assert.ok(stored.every((p) => p.bytes.byteLength > 1000 && /^[0-9a-f]{64}$/.test(p.sha256) && p.capturedAt));
  }
  reopened.close();
});

test('a Bench iPad sends its queued Bench sessions with their own role and scanned code', async () => {
  const { store, service, engine } = await setup();
  service.role = 'bench';
  const a = roleSession('bench', '5698-D');
  const b = roleSession('bench', '5626-2-F');
  await store.saveSession(a, photos(2, 'a'));
  await store.saveSession(b, photos(1, 'b'));
  assert.deepEqual(await engine.syncAll(), { outcome: 'done', sent: 2, failed: 0 });
  assert.deepEqual([...new Set(service.uploads.map((u) => `${u.role} ${u.code}`))], ['bench 5698-D', 'bench 5626-2-F']);
  assert.deepEqual(service.completes, [
    { sessionId: a.sessionId, role: 'bench', code: '5698-D', photosSaved: 2 },
    { sessionId: b.sessionId, role: 'bench', code: '5626-2-F', photosSaved: 1 }
  ]);
  assert.deepEqual(await store.listSessions(), []);
});

test('re-paired as another role: sessions taken as the old role are kept, never sent; matching ones still go', async () => {
  const { store, service, engine } = await setup();
  service.role = 'delivery'; // this iPad was a Bench iPad when these were taken
  const bench = roleSession('bench', '5698-D');
  const delivery = roleSession('delivery', '5701-DELIV');
  await store.saveSession(bench, photos(2, 'bench'));
  await store.saveSession(delivery, photos(1, 'deliv'));

  assert.deepEqual(await engine.syncAll(), { outcome: 'done', sent: 1, failed: 1 });
  assert.deepEqual(service.uploads.map((u) => u.code), ['5701-DELIV'], 'nothing of the Bench session was uploaded');
  const [kept] = await store.listSessions();
  assert.equal(kept.sessionId, bench.sessionId);
  assert.equal(kept.status, Queue.STATUS.WRONG_ROLE);
  assert.equal((await store.getPhotos(bench.sessionId)).length, 2, 'every photo kept');

  // Paired as Bench again on the PC: it goes.
  service.role = 'bench';
  assert.deepEqual(await engine.syncAll(), { outcome: 'done', sent: 1, failed: 0 });
  assert.deepEqual(await store.listSessions(), []);
});

test('the PC refusing a photo for the wrong role keeps the whole session on the iPad', async () => {
  const { store, service, engine } = await setup();
  const session = roleSession('delivery', '5698-DELIV');
  const shots = photos(2);
  await store.saveSession(session, shots);
  service.wrongRolePhotoIds.add(shots[0].photoId);
  assert.deepEqual(await engine.syncAll(), { outcome: 'done', sent: 0, failed: 1 });
  const [kept] = await store.listSessions();
  assert.equal(kept.status, Queue.STATUS.WRONG_ROLE);
  assert.deepEqual(service.completes, []);
});

test('a session queued before roles existed (no role, no code) is sent as the Delivery it was', async () => {
  const indexedDB = new IDBFactory();
  const store = await Queue.openStore({ indexedDB });
  const legacy = { sessionId: randomUUID(), reference: '5698-P-DELIV', orderNumber: '5698', deliveryType: 'Part Delivery', partNo: 1 };
  await store.saveSession(legacy, photos(1, 'legacy'));
  // Strip the new fields, exactly as a record written by the previous version looks.
  await new Promise((resolve, reject) => {
    const open = indexedDB.open(Queue.DB_NAME);
    open.onsuccess = () => {
      const tx = open.result.transaction('sessions', 'readwrite');
      const os = tx.objectStore('sessions');
      const get = os.get(legacy.sessionId);
      get.onsuccess = () => {
        const { role, code, baseOrder, ...old } = get.result;
        os.put(old);
      };
      tx.oncomplete = () => {
        open.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
  const [record] = await store.listSessions();
  assert.equal(record.role, undefined);

  const service = fakeService();
  const engine = Queue.createSyncEngine({ store, api: service });
  assert.deepEqual(await engine.syncAll(), { outcome: 'done', sent: 1, failed: 0 });
  assert.deepEqual(service.completes, [{ sessionId: legacy.sessionId, role: 'delivery', code: '5698-P-DELIV', photosSaved: 1 }]);
});

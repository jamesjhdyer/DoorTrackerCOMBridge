'use strict';

// End to end, without a browser: the iPad's real offline queue and sync
// engine (delivery-photos-web/offline-queue.js) sending to the REAL local
// HTTPS Photo Service, which files into a temp folder standing in for the
// network drive through the real forked archive worker. The only stand-ins
// are an in-memory IndexedDB and a small Node HTTPS client playing the part
// of the iPad's fetch/XHR calls. Never real photographs, never the real drive.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const nodePath = require('node:path');
const { randomUUID } = require('node:crypto');
const { IDBFactory } = require('fake-indexeddb');

const Queue = require(nodePath.join(__dirname, '..', '..', 'delivery-photos-web', 'offline-queue.js'));
const { parse } = require('./reference');
const PhotoRoles = require('./photo-roles');
const { startServers } = require('./http-server');
const { ensureCertificates } = require('./certs');
const { runInWorker } = require('./worker-runner');
const { makeEnv, jpeg, quietLogger } = require('./helpers');
const { PairingManager } = require('./auth');
const { ConcurrencyLimiter } = require('./concurrency');
const { listPendingEvents } = require('./tracking');
const { countOrdersFiledOn } = require('./filed-today');

process.env.DELIVERY_PHOTOS_TEST_HOOKS = '1';

let nextPort = 9400;

// A Photo Service that can be switched off and on again on the same port,
// with the same certificate and the same paired devices - like the iPad
// leaving and coming back to the workshop Wi-Fi.
function makeService(env, configOverrides = {}) {
  const port = nextPort;
  nextPort += 2;
  const config = { hostname: 'localhost', port, photoRoot: env.share, maxPhotoBytes: 5 * 1000 * 1000, operationTimeoutSeconds: 10, minFreeGb: 0, ...configOverrides };
  const credentials = ensureCertificates(nodePath.join(env.home, 'certs'), 'localhost');
  const pairing = new PairingManager({ devicesPath: nodePath.join(env.home, 'paired-devices.json') });
  const queueDir = nodePath.join(env.home, 'tracking-queue');
  const filedLogDir = nodePath.join(env.home, 'filed-sessions');
  const agent = new https.Agent({ ca: credentials.caCert, keepAlive: false });
  let handle = null;
  return {
    port,
    pairing,
    queueDir,
    filedLogDir,
    agent,
    async start() {
      handle = startServers({ config, credentials, runWorker: runInWorker, logger: quietLogger(), spoolDir: env.spool, pairing, limiter: new ConcurrencyLimiter(), queueDir, filedLogDir });
      await handle.listen();
    },
    async stop() {
      if (handle) await handle.close();
      handle = null;
    }
  };
}

function call(service, { method, path, token, body, headers = {} }) {
  return new Promise((resolve) => {
    const req = https.request(
      { agent: service.agent, host: 'localhost', port: service.port, method, path, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, timeout: 15000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let data = {};
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // non-JSON
          }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('error', () => resolve({ status: 0, data: {} })); // connection refused = PC out of reach
    req.on('timeout', () => req.destroy());
    if (body) req.write(body);
    req.end();
  });
}

// The same three calls app.js makes, over a real HTTPS connection.
function iPadApi(service, getToken) {
  return {
    async checkService() {
      const res = await call(service, { method: 'GET', path: '/api/pair/check', token: getToken() });
      if (res.status !== 200) return { reachable: false, paired: false };
      const paired = Boolean(getToken() && res.data.paired);
      return { reachable: true, paired, role: paired ? res.data.role : null };
    },
    async uploadPhoto({ role, code, photoId, bytes, sha256 }) {
      const headers = { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256, ...(role ? { 'X-Photo-Role': role } : {}) };
      const res = await call(service, { method: 'PUT', path: `/api/photos/${encodeURIComponent(code)}/${photoId}`, token: getToken(), body: Buffer.from(bytes), headers });
      if (res.status === 0) return { ok: false, unreachable: true, error: 'Could not reach the Delivery Photos service on this PC.' };
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, data: res.data };
      return { ok: false, status: res.status, error: res.data.message || `HTTP ${res.status}`, needsPairing: res.status === 401, wrongRole: res.status === 403 };
    },
    async completeSession({ sessionId, role, code, photosSaved }) {
      const res = await call(service, { method: 'POST', path: '/api/photo-sessions/complete', token: getToken(), body: Buffer.from(JSON.stringify({ sessionId, code, photosSaved })), headers: { 'Content-Type': 'application/json', 'X-Photo-Role': role } });
      if (res.status === 0) return { ok: false, unreachable: true, error: 'Could not reach the Delivery Photos service on this PC.' };
      if (res.status >= 200 && res.status < 300) return { ok: true, data: res.data };
      return { ok: false, status: res.status, error: res.data.message || `HTTP ${res.status}`, needsPairing: res.status === 401, wrongRole: res.status === 403 };
    }
  };
}

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

function shots(n, label) {
  return Array.from({ length: n }, (_, i) => ({ photoId: randomUUID(), bytes: toArrayBuffer(jpeg(`${label}-${i}`, 3000 + i)), capturedAt: new Date().toISOString() }));
}

async function queueSession(store, reference, photos) {
  const session = { sessionId: randomUUID(), ...Queue.deliveryMetadata(parse(reference)) };
  await store.saveSession(session, photos);
  return session;
}

function filesIn(env, folder) {
  try {
    return fs.readdirSync(nodePath.join(env.share, folder)).sort();
  } catch {
    return [];
  }
}

async function queueRoleSession(store, role, code, photos) {
  const parsed = PhotoRoles.parseForRole(role, code);
  assert.equal(parsed.ok, true, parsed.reason);
  const session = { sessionId: randomUUID(), ...Queue.sessionMetadata(parsed) };
  await store.saveSession(session, photos);
  return session;
}

async function setup(env, configOverrides, role = 'delivery') {
  const service = makeService(env, configOverrides);
  const token = { value: service.pairing.pair(service.pairing.generateCode({ role }).code).token };
  const store = await Queue.openStore({ indexedDB: new IDBFactory() });
  const engine = Queue.createSyncEngine({ store, api: iPadApi(service, () => token.value) });
  return { service, token, store, engine };
}

test('away from the workshop: deliveries queue on the iPad, nothing is filed or counted, then all send on reconnect', async () => {
  const env = makeEnv();
  const { service, store, engine } = await setup(env);
  try {
    // PC out of reach (service not running).
    const full = await queueSession(store, '5698-DELIV', shots(2, 'full'));
    const part1 = await queueSession(store, '5698-P-DELIV', shots(1, 'p1'));
    const part2 = await queueSession(store, '5698-P2-DELIV', shots(3, 'p2'));
    const other = await queueSession(store, '5701-DELIV', shots(1, 'other'));

    const offline = await engine.syncAll();
    assert.equal(offline.outcome, 'unreachable');
    assert.equal((await store.listSessions()).length, 4, 'all four still safely on the iPad');
    assert.deepEqual(listPendingEvents(service.queueDir), [], 'no tracking event for an iPad-only session');
    assert.equal(countOrdersFiledOn(service.filedLogDir), 0, 'Orders filed today does not count iPad-only sessions');

    // Back on the workshop Wi-Fi.
    await service.start();
    const before = Date.now();
    const online = await engine.syncAll();
    assert.deepEqual(online, { outcome: 'done', sent: 4, failed: 0 });

    // Full, part 1 and part 2 of order 5698 all file into folder 5698, numbered in send order.
    assert.deepEqual(filesIn(env, '5698'), ['001-DELIV.jpg', '002-DELIV.jpg', '003-DELIV.jpg', '004-DELIV.jpg', '005-DELIV.jpg', '006-DELIV.jpg']);
    assert.deepEqual(filesIn(env, '5701'), ['001-DELIV.jpg']);

    const events = listPendingEvents(service.queueDir);
    assert.deepEqual(events.map((e) => e.eventId).sort(), [full, part1, part2, other].map((s) => s.sessionId).sort(), 'one event per session, keyed by its session id');
    const byRef = Object.fromEntries(events.map((e) => [e.reference, e]));
    assert.deepEqual([byRef['5698-P2-DELIV'].deliveryType, byRef['5698-P2-DELIV'].partNo, byRef['5698-P2-DELIV'].photosSaved], ['Part Delivery', 2, 3]);
    for (const e of events) assert.ok(Date.parse(e.savedAt) >= before - 1000, 'Saved Date/Time is when it was actually filed, not when it was captured');
    assert.equal(countOrdersFiledOn(service.filedLogDir), 2, '5698 (three sessions) + 5701');
    assert.deepEqual(await store.listSessions(), [], 'local copies removed only after verified completion');
  } finally {
    await service.stop();
    store.close();
    env.cleanup();
  }
});

test('a crash after the PC filed a photo but before the iPad noted it: the re-send does not duplicate the file', async () => {
  const env = makeEnv();
  const { service, token, store, engine } = await setup(env);
  try {
    await service.start();
    const photos = shots(3, 'crash');
    const session = await queueSession(store, '5698-DELIV', photos);

    // The PC receives and files photos 1 and 2, but the iPad "crashes" before
    // recording either as sent (its IndexedDB still says not uploaded).
    const api = iPadApi(service, () => token.value);
    const stored = await store.getPhotos(session.sessionId);
    for (const p of stored.slice(0, 2)) assert.equal((await api.uploadPhoto({ role: 'delivery', code: '5698-DELIV', photoId: p.photoId, bytes: p.bytes, sha256: p.sha256 })).ok, true);
    await store.updateSession(session.sessionId, { status: Queue.STATUS.SYNCING }); // left mid-sync

    const result = await engine.syncAll();
    assert.deepEqual(result, { outcome: 'done', sent: 1, failed: 0 });
    assert.deepEqual(filesIn(env, '5698'), ['001-DELIV.jpg', '002-DELIV.jpg', '003-DELIV.jpg'], 'three photos, three files, three numbers - none filed twice');
    assert.equal(listPendingEvents(service.queueDir).length, 1);
  } finally {
    await service.stop();
    store.close();
    env.cleanup();
  }
});

test('a crash after the completion was acknowledged but before the local copy was removed: no second event or Sheet row', async () => {
  const env = makeEnv();
  const { service, token, store, engine } = await setup(env);
  try {
    await service.start();
    const session = await queueSession(store, '5701-P2-DELIV', shots(2, 'ack'));
    const api = iPadApi(service, () => token.value);
    for (const p of await store.getPhotos(session.sessionId)) {
      await api.uploadPhoto({ role: 'delivery', code: '5701-P2-DELIV', photoId: p.photoId, bytes: p.bytes, sha256: p.sha256 });
      await store.markPhotoUploaded(p.photoId);
    }
    assert.equal((await api.completeSession({ sessionId: session.sessionId, role: 'delivery', code: '5701-P2-DELIV', photosSaved: 2 })).ok, true);
    // ...crash here: the session is still in IndexedDB.

    const result = await engine.syncAll();
    assert.equal(result.outcome, 'done');
    const events = listPendingEvents(service.queueDir);
    assert.equal(events.length, 1, 'the repeat report is recognised, not recorded twice');
    assert.equal(events[0].eventId, session.sessionId);
    assert.equal(countOrdersFiledOn(service.filedLogDir), 1);
    assert.deepEqual(filesIn(env, '5701'), ['001-DELIV.jpg', '002-DELIV.jpg']);
    assert.deepEqual(await store.listSessions(), []);
  } finally {
    await service.stop();
    store.close();
    env.cleanup();
  }
});

test('pairing reset on the PC: nothing is sent or deleted; after pairing again everything goes through', async () => {
  const env = makeEnv();
  const { service, token, store, engine } = await setup(env);
  try {
    await service.start();
    await queueSession(store, '5698-DELIV', shots(2, 'a'));
    await queueSession(store, '5701-DELIV', shots(1, 'b'));
    service.pairing.revokeAll();

    const blocked = await engine.syncAll();
    assert.equal(blocked.outcome, 'needs_pairing');
    const sessions = await store.listSessions();
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((s) => s.status === Queue.STATUS.NEEDS_PAIRING));
    assert.deepEqual(filesIn(env, '5698'), []);
    assert.deepEqual(listPendingEvents(service.queueDir), []);

    token.value = service.pairing.pair(service.pairing.generateCode({ role: 'delivery' }).code).token; // paired again
    const after = await engine.syncAll();
    assert.deepEqual(after, { outcome: 'done', sent: 2, failed: 0 });
    assert.deepEqual(filesIn(env, '5698'), ['001-DELIV.jpg', '002-DELIV.jpg']);
    assert.equal(countOrdersFiledOn(service.filedLogDir), 2);
  } finally {
    await service.stop();
    store.close();
    env.cleanup();
  }
});

test('one photo the PC cannot accept: the session stays queued, no tracking event, not counted', async () => {
  const env = makeEnv();
  const { service, store, engine } = await setup(env);
  try {
    await service.start();
    const photos = shots(3, 'bad');
    const notAJpeg = Buffer.alloc(4000, 7); // the PC refuses this one
    photos[1] = { ...photos[1], bytes: toArrayBuffer(notAJpeg) };
    const session = await queueSession(store, '5698-DELIV', photos);

    const result = await engine.syncAll();
    assert.deepEqual(result, { outcome: 'done', sent: 0, failed: 1 });
    const record = await store.getSession(session.sessionId);
    assert.equal(record.status, Queue.STATUS.FAILED);
    assert.match(record.lastError, /JPEG/);
    assert.deepEqual(listPendingEvents(service.queueDir), [], 'no tracking event for an incomplete session');
    assert.equal(countOrdersFiledOn(service.filedLogDir), 0);
    assert.equal((await store.getPhotos(session.sessionId)).length, 3, 'every photo still on the iPad');
  } finally {
    await service.stop();
    store.close();
    env.cleanup();
  }
});

test('the company drive unavailable: photos stay on the iPad and are sent once it is back', async () => {
  const env = makeEnv();
  const missing = nodePath.join(env.base, 'drive-not-connected');
  const { service, store, engine } = await setup(env, { photoRoot: missing });
  try {
    await service.start();
    const session = await queueSession(store, '5698-DELIV', shots(2, 'drive'));
    const result = await engine.syncAll();
    assert.deepEqual(result, { outcome: 'done', sent: 0, failed: 1 });
    assert.equal((await store.getSession(session.sessionId)).status, Queue.STATUS.FAILED);
    assert.deepEqual(listPendingEvents(service.queueDir), []);

    fs.mkdirSync(missing); // the drive is reconnected
    const retry = await engine.syncAll();
    assert.deepEqual(retry, { outcome: 'done', sent: 1, failed: 0 });
    assert.deepEqual(fs.readdirSync(nodePath.join(missing, '5698')).sort(), ['001-DELIV.jpg', '002-DELIV.jpg']);
  } finally {
    await service.stop();
    store.close();
    env.cleanup();
  }
});

// ---- Photo roles, offline ------------------------------------------------------

// A second (third...) iPad, paired as `role`, with its own offline queue -
// talking to the same Photo Service.
async function anotherIpad(service, role) {
  const token = { value: service.pairing.pair(service.pairing.generateCode({ role }).code).token };
  const store = await Queue.openStore({ indexedDB: new IDBFactory() });
  const engine = Queue.createSyncEngine({ store, api: iPadApi(service, () => token.value) });
  return { token, store, engine };
}

test('all three roles offline: queued apart from the PC, then filed into the right order folders with server-chosen names', async () => {
  const env = makeEnv();
  const { service, store: deliveryStore, engine: deliveryEngine } = await setup(env, undefined, 'delivery');
  const bench = await anotherIpad(service, 'bench');
  const irn = await anotherIpad(service, 'ironmongery');
  try {
    // Already on the drive before anything is sent: one Bench photo of 5698.
    fs.mkdirSync(nodePath.join(env.share, '5698'));
    fs.writeFileSync(nodePath.join(env.share, '5698', '001-BENCH.jpg'), 'earlier bench photo');

    const delivery = await queueRoleSession(deliveryStore, 'delivery', '5698-P2-DELIV', shots(2, 'deliv'));
    const benchSession = await queueRoleSession(bench.store, 'bench', '5626-2-D', shots(2, 'bench'));
    await queueRoleSession(irn.store, 'ironmongery', '5626-2', shots(1, 'irn'));

    for (const e of [deliveryEngine, bench.engine, irn.engine]) assert.equal((await e.syncAll()).outcome, 'unreachable');
    assert.deepEqual(filesIn(env, '5626-2'), []);
    // Still there after "closing and reopening" (re-listing the same databases).
    const [queuedBench] = await bench.store.listSessions();
    assert.deepEqual([queuedBench.role, queuedBench.code, queuedBench.baseOrder, queuedBench.photoCount], ['bench', '5626-2-D', '5626-2', 2]);

    await service.start();
    assert.deepEqual(await deliveryEngine.syncAll(), { outcome: 'done', sent: 1, failed: 0 });
    // Order 5626-2 already has one delivery photo when the Bench iPad sends.
    fs.mkdirSync(nodePath.join(env.share, '5626-2'));
    fs.writeFileSync(nodePath.join(env.share, '5626-2', '001-DELIV.jpg'), 'earlier delivery photo');
    assert.deepEqual(await bench.engine.syncAll(), { outcome: 'done', sent: 1, failed: 0 });
    assert.deepEqual(await irn.engine.syncAll(), { outcome: 'done', sent: 1, failed: 0 });

    assert.deepEqual(filesIn(env, '5698'), ['001-BENCH.jpg', '002-DELIV.jpg', '003-DELIV.jpg']);
    assert.deepEqual(filesIn(env, '5626-2'), ['001-DELIV.jpg', '002-BENCH.jpg', '003-BENCH.jpg', '004-IRN.jpg']);

    // Only the Delivery session reaches the Sheet queue - with its part details from the scan.
    const events = listPendingEvents(service.queueDir);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].eventId, events[0].reference, events[0].deliveryType, events[0].partNo, events[0].photosSaved], [delivery.sessionId, '5698-P2-DELIV', 'Part Delivery', 2, 2]);
    assert.notEqual(events[0].eventId, benchSession.sessionId);
    assert.equal(countOrdersFiledOn(service.filedLogDir), 1);

    for (const s of [deliveryStore, bench.store, irn.store]) assert.deepEqual(await s.listSessions(), [], 'each local copy removed only after verified completion');
  } finally {
    await service.stop();
    for (const s of [deliveryStore, bench.store, irn.store]) s.close();
    env.cleanup();
  }
});

test('a queued record edited to claim another role gains nothing: the PC files by the token\'s role or refuses', async () => {
  const env = makeEnv();
  const { service, token, store, engine } = await setup(env, undefined, 'bench');
  try {
    await service.start();
    const session = await queueRoleSession(store, 'bench', '5698-D', shots(1, 'tamper'));

    // Someone edits the queued record on the iPad to pose as a Delivery.
    await store.updateSession(session.sessionId, { role: 'delivery', code: '5698-DELIV', reference: '5698-DELIV' });
    const result = await engine.syncAll();
    assert.deepEqual(result, { outcome: 'done', sent: 0, failed: 1 });
    assert.equal((await store.getSession(session.sessionId)).status, Queue.STATUS.WRONG_ROLE, 'the iPad itself will not send it as another role');

    // And sending it directly, bypassing the iPad's own checks, is refused by the PC every way round.
    const api = iPadApi(service, () => token.value);
    const [photo] = await store.getPhotos(session.sessionId);
    const send = (role, code) => api.uploadPhoto({ role, code, photoId: photo.photoId, bytes: photo.bytes, sha256: photo.sha256 });
    assert.equal((await send('delivery', '5698-DELIV')).status, 403, 'claiming Delivery from a Bench token');
    assert.equal((await send('bench', '5698-DELIV')).status, 400, 'a Delivery code from a Bench token');
    assert.equal((await send(undefined, '5698-DELIV')).status, 400, 'no claim at all: still parsed as Bench');
    assert.equal((await send('ironmongery', '5698')).status, 403);
    assert.deepEqual(fs.readdirSync(env.share).filter((n) => n !== '.incoming'), [], 'nothing filed');
    assert.equal((await api.completeSession({ sessionId: session.sessionId, role: 'delivery', code: '5698-DELIV', photosSaved: 1 })).status, 403);
    assert.deepEqual(listPendingEvents(service.queueDir), [], 'no Delivery Sheet row from a Bench iPad');

    // Restored to what it really was, it files as -BENCH, under the token's role.
    await store.updateSession(session.sessionId, { role: 'bench', code: '5698-D', reference: '' });
    assert.deepEqual(await engine.syncAll(), { outcome: 'done', sent: 1, failed: 0 });
    assert.deepEqual(filesIn(env, '5698'), ['001-BENCH.jpg']);
  } finally {
    await service.stop();
    store.close();
    env.cleanup();
  }
});

test('re-paired as a different role while photos were queued: they are kept, not sent, until paired as that role again', async () => {
  const env = makeEnv();
  const { service, token, store, engine } = await setup(env, undefined, 'ironmongery');
  try {
    await queueRoleSession(store, 'ironmongery', '5626-2', shots(2, 'irn'));
    await service.start();
    service.pairing.revokeAll();
    token.value = service.pairing.pair(service.pairing.generateCode({ role: 'delivery' }).code).token;

    assert.deepEqual(await engine.syncAll(), { outcome: 'done', sent: 0, failed: 1 });
    const [kept] = await store.listSessions();
    assert.equal(kept.status, Queue.STATUS.WRONG_ROLE);
    assert.equal((await store.getPhotos(kept.sessionId)).length, 2);
    assert.deepEqual(filesIn(env, '5626-2'), []);

    service.pairing.revokeAll();
    token.value = service.pairing.pair(service.pairing.generateCode({ role: 'ironmongery' }).code).token;
    assert.deepEqual(await engine.syncAll(), { outcome: 'done', sent: 1, failed: 0 });
    assert.deepEqual(filesIn(env, '5626-2'), ['001-IRN.jpg', '002-IRN.jpg']);
    assert.deepEqual(listPendingEvents(service.queueDir), []);
  } finally {
    await service.stop();
    store.close();
    env.cleanup();
  }
});

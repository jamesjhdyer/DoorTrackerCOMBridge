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
      return { reachable: true, paired: Boolean(getToken() && res.data.paired) };
    },
    async uploadPhoto({ reference, photoId, bytes, sha256 }) {
      const res = await call(service, { method: 'PUT', path: `/api/photos/${reference}/${photoId}`, token: getToken(), body: Buffer.from(bytes), headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256 } });
      if (res.status === 0) return { ok: false, unreachable: true, error: 'Could not reach the Delivery Photos service on this PC.' };
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, error: res.data.message || `HTTP ${res.status}`, needsPairing: res.status === 401 };
    },
    async completeSession({ sessionId, reference, photosSaved }) {
      const res = await call(service, { method: 'POST', path: '/api/delivery-sessions/complete', token: getToken(), body: Buffer.from(JSON.stringify({ sessionId, reference, photosSaved })), headers: { 'Content-Type': 'application/json' } });
      if (res.status === 0) return { ok: false, unreachable: true, error: 'Could not reach the Delivery Photos service on this PC.' };
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, error: res.data.message || `HTTP ${res.status}`, needsPairing: res.status === 401 };
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

async function setup(env, configOverrides) {
  const service = makeService(env, configOverrides);
  const token = { value: service.pairing.pair(service.pairing.generateCode().code).token };
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

    assert.deepEqual(filesIn(env, '5698-DELIV'), ['photo-001.jpg', 'photo-002.jpg']);
    assert.deepEqual(filesIn(env, '5698-P-DELIV'), ['photo-001.jpg']);
    assert.deepEqual(filesIn(env, '5698-P2-DELIV'), ['photo-001.jpg', 'photo-002.jpg', 'photo-003.jpg']);
    assert.deepEqual(filesIn(env, '5701-DELIV'), ['photo-001.jpg']);

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
    for (const p of stored.slice(0, 2)) assert.equal((await api.uploadPhoto({ reference: '5698-DELIV', photoId: p.photoId, bytes: p.bytes, sha256: p.sha256 })).ok, true);
    await store.updateSession(session.sessionId, { status: Queue.STATUS.SYNCING }); // left mid-sync

    const result = await engine.syncAll();
    assert.deepEqual(result, { outcome: 'done', sent: 1, failed: 0 });
    assert.deepEqual(filesIn(env, '5698-DELIV'), ['photo-001.jpg', 'photo-002.jpg', 'photo-003.jpg'], 'three photos, three files - none filed twice');
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
      await api.uploadPhoto({ reference: '5701-P2-DELIV', photoId: p.photoId, bytes: p.bytes, sha256: p.sha256 });
      await store.markPhotoUploaded(p.photoId);
    }
    assert.equal((await api.completeSession({ sessionId: session.sessionId, reference: '5701-P2-DELIV', photosSaved: 2 })).ok, true);
    // ...crash here: the session is still in IndexedDB.

    const result = await engine.syncAll();
    assert.equal(result.outcome, 'done');
    const events = listPendingEvents(service.queueDir);
    assert.equal(events.length, 1, 'the repeat report is recognised, not recorded twice');
    assert.equal(events[0].eventId, session.sessionId);
    assert.equal(countOrdersFiledOn(service.filedLogDir), 1);
    assert.deepEqual(filesIn(env, '5701-P2-DELIV'), ['photo-001.jpg', 'photo-002.jpg']);
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
    assert.deepEqual(filesIn(env, '5698-DELIV'), []);
    assert.deepEqual(listPendingEvents(service.queueDir), []);

    token.value = service.pairing.pair(service.pairing.generateCode().code).token; // paired again
    const after = await engine.syncAll();
    assert.deepEqual(after, { outcome: 'done', sent: 2, failed: 0 });
    assert.deepEqual(filesIn(env, '5698-DELIV'), ['photo-001.jpg', 'photo-002.jpg']);
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
    assert.deepEqual(fs.readdirSync(nodePath.join(missing, '5698-DELIV')).sort(), ['photo-001.jpg', 'photo-002.jpg']);
  } finally {
    await service.stop();
    store.close();
    env.cleanup();
  }
});

'use strict';

// Tests main.js's Google Sheets sync loop (tracking-sync.js) against a fake
// fetch - never the real website or Google Sheets.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');

const { createTrackingEvent, listPendingEvents } = require('./tracking');
const { createTrackingSync } = require('./tracking-sync');
const { makeEnv, quietLogger } = require('./helpers');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body };
}

// A stand-in for the website's POST /api/delivery-photo-scans: one "Sheet
// row" per new eventId, and "already recorded" (200, created:false) for a
// repeat - exactly what the real route answers. `online` can be flipped to
// simulate Google Sheets / the internet being unavailable.
function fakeWebsite() {
  const site = { online: true, rows: [], calls: 0 };
  site.fetch = async (url, init) => {
    site.calls++;
    assert.match(url, /\/api\/delivery-photo-scans$/);
    if (!site.online) throw new Error('getaddrinfo ENOTFOUND');
    const body = JSON.parse(init.body);
    if (site.rows.some((row) => row.eventId === body.eventId)) return jsonResponse(200, { ok: true, created: false });
    site.rows.push(body);
    return jsonResponse(201, { ok: true, created: true });
  };
  return site;
}

function makeSync(env, site, overrides = {}) {
  return createTrackingSync({
    queueDir: () => nodePath.join(env.home, 'tracking-queue'),
    getApiBase: () => 'https://tracker.example',
    logger: quietLogger(),
    fetchImpl: site.fetch,
    ...overrides
  });
}

function queue(env, reference, photosSaved = 2) {
  return createTrackingEvent({ reference, photosSaved }, { queueDir: nodePath.join(env.home, 'tracking-queue') });
}

test('a full delivery and its two part deliveries each become their own Sheet row', async () => {
  const env = makeEnv();
  try {
    const site = fakeWebsite();
    for (const ref of ['5698-DELIV', '5698-P-DELIV', '5698-P2-DELIV']) queue(env, ref);
    await makeSync(env, site).syncPending();

    assert.deepEqual(site.rows.map((r) => [r.orderNumber, r.reference, r.deliveryType, r.partNo]).sort(), [
      ['5698', '5698-DELIV', 'Full Delivery', ''],
      ['5698', '5698-P-DELIV', 'Part Delivery', 1],
      ['5698', '5698-P2-DELIV', 'Part Delivery', 2]
    ]);
    assert.equal(new Set(site.rows.map((r) => r.eventId)).size, 3);
    assert.deepEqual(listPendingEvents(nodePath.join(env.home, 'tracking-queue')), []);
  } finally {
    env.cleanup();
  }
});

test('Sheets offline: the event stays queued with the error recorded, then syncs once back online', async () => {
  const env = makeEnv();
  try {
    const site = fakeWebsite();
    site.online = false;
    queue(env, '5698-DELIV');
    const sync = makeSync(env, site);

    await sync.syncPending();
    let pending = listPendingEvents(nodePath.join(env.home, 'tracking-queue'));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].attempts, 1);
    assert.match(pending[0].lastError, /ENOTFOUND/);
    assert.match(sync.status.lastSyncError, /ENOTFOUND/);
    assert.equal(site.rows.length, 0);

    site.online = true;
    await sync.syncPending();
    pending = listPendingEvents(nodePath.join(env.home, 'tracking-queue'));
    assert.deepEqual(pending, []);
    assert.equal(site.rows.length, 1);
  } finally {
    env.cleanup();
  }
});

test('a website error (e.g. 500 from a Sheets failure) also keeps the event queued', async () => {
  const env = makeEnv();
  try {
    queue(env, '5698-DELIV');
    const sync = makeSync(env, {}, { fetchImpl: async () => jsonResponse(500, { error: 'The "DELIVERY_PHOTO_SCANS" tab ... does not have the expected header row' }) });
    await sync.syncPending();
    const pending = listPendingEvents(nodePath.join(env.home, 'tracking-queue'));
    assert.equal(pending.length, 1);
    assert.match(pending[0].lastError, /expected header row/);
  } finally {
    env.cleanup();
  }
});

test('pending events survive a restart: a brand-new sync instance (as after relaunching the app) picks them up', async () => {
  const env = makeEnv();
  try {
    const site = fakeWebsite();
    site.online = false;
    queue(env, '5698-DELIV');
    queue(env, '5701-DELIV');
    await makeSync(env, site).syncPending();

    site.online = true;
    await makeSync(env, site).syncPending(); // fresh instance, nothing carried over in memory
    assert.deepEqual(site.rows.map((r) => r.reference).sort(), ['5698-DELIV', '5701-DELIV']);
    assert.deepEqual(listPendingEvents(nodePath.join(env.home, 'tracking-queue')), []);
  } finally {
    env.cleanup();
  }
});

test('a lost acknowledgement is retried without creating a duplicate Sheet row (Event ID dedupe)', async () => {
  const env = makeEnv();
  try {
    const site = fakeWebsite();
    queue(env, '5698-DELIV');
    let first = true;
    // The row gets written, but the reply never makes it back.
    const lossyFetch = async (url, init) => {
      const res = await site.fetch(url, init);
      if (first) {
        first = false;
        throw new Error('socket hang up');
      }
      return res;
    };
    const sync = makeSync(env, site, { fetchImpl: lossyFetch });
    await sync.syncPending();
    assert.equal(listPendingEvents(nodePath.join(env.home, 'tracking-queue')).length, 1, 'still pending - no acknowledgement arrived');

    await sync.syncPending();
    assert.equal(site.rows.length, 1, 'the retry must not add a second row');
    assert.deepEqual(listPendingEvents(nodePath.join(env.home, 'tracking-queue')), []);
  } finally {
    env.cleanup();
  }
});

test('no website configured yet: nothing is attempted and the queue simply waits', async () => {
  const env = makeEnv();
  try {
    const site = fakeWebsite();
    queue(env, '5698-DELIV');
    await makeSync(env, site, { getApiBase: () => null }).syncPending();
    assert.equal(site.calls, 0);
    assert.equal(listPendingEvents(nodePath.join(env.home, 'tracking-queue')).length, 1);
  } finally {
    env.cleanup();
  }
});

test('a hung request times out instead of blocking the queue', async () => {
  const env = makeEnv();
  try {
    queue(env, '5698-DELIV');
    const hangingFetch = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const sync = makeSync(env, {}, { fetchImpl: hangingFetch, timeoutMs: 50 });
    await sync.syncPending();
    assert.equal(sync.status.lastSyncError, 'Request timed out');
    assert.equal(listPendingEvents(nodePath.join(env.home, 'tracking-queue')).length, 1);
  } finally {
    env.cleanup();
  }
});

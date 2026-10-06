'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

const { TrackingError, createTrackingEvent, listPendingEvents, removeEvent, recordAttemptFailure } = require('./tracking');
const { makeEnv } = require('./helpers');

function queueDir(env) {
  return nodePath.join(env.home, 'tracking-queue');
}

test('a standard delivery produces Full Delivery with a blank Part No.', () => {
  const env = makeEnv();
  try {
    const record = createTrackingEvent({ reference: '5698-DELIV', photosSaved: 3 }, { queueDir: queueDir(env) });
    assert.equal(record.orderNumber, '5698');
    assert.equal(record.reference, '5698-DELIV');
    assert.equal(record.deliveryType, 'Full Delivery');
    assert.equal(record.partNo, '');
    assert.equal(record.photosSaved, 3);
    assert.ok(record.eventId);
    assert.ok(record.savedAt);
  } finally {
    env.cleanup();
  }
});

test('"-P-DELIV" (no number) maps to Part Delivery, Part No. 1', () => {
  const env = makeEnv();
  try {
    const record = createTrackingEvent({ reference: '5698-P-DELIV', photosSaved: 2 }, { queueDir: queueDir(env) });
    assert.equal(record.orderNumber, '5698');
    assert.equal(record.deliveryType, 'Part Delivery');
    assert.equal(record.partNo, 1);
  } finally {
    env.cleanup();
  }
});

test('P2 and P3 deliveries map to Part No. 2 and 3', () => {
  const env = makeEnv();
  try {
    const p2 = createTrackingEvent({ reference: '5698-P2-DELIV', photosSaved: 1 }, { queueDir: queueDir(env) });
    assert.equal(p2.deliveryType, 'Part Delivery');
    assert.equal(p2.partNo, 2);

    const p3 = createTrackingEvent({ reference: '5626-2-P3-DELIV', photosSaved: 4 }, { queueDir: queueDir(env) });
    assert.equal(p3.deliveryType, 'Part Delivery');
    assert.equal(p3.partNo, 3);
  } finally {
    env.cleanup();
  }
});

test('an order number with its own internal hyphen is preserved exactly', () => {
  const env = makeEnv();
  try {
    const record = createTrackingEvent({ reference: '5626-2-P3-DELIV', photosSaved: 1 }, { queueDir: queueDir(env) });
    assert.equal(record.orderNumber, '5626-2');
    assert.equal(record.reference, '5626-2-P3-DELIV');
  } finally {
    env.cleanup();
  }
});

test('an invalid delivery reference is refused, and nothing is queued', () => {
  const env = makeEnv();
  try {
    assert.throws(() => createTrackingEvent({ reference: 'not-a-code', photosSaved: 1 }, { queueDir: queueDir(env) }), TrackingError);
    assert.deepEqual(listPendingEvents(queueDir(env)), []);
  } finally {
    env.cleanup();
  }
});

test('photosSaved must be a real positive count', () => {
  const env = makeEnv();
  try {
    for (const bad of [0, -1, 1.5, 'three', null, undefined]) {
      assert.throws(() => createTrackingEvent({ reference: '5698-DELIV', photosSaved: bad }, { queueDir: queueDir(env) }), TrackingError, JSON.stringify(bad));
    }
    assert.deepEqual(listPendingEvents(queueDir(env)), []);
  } finally {
    env.cleanup();
  }
});

test('two sessions for the same delivery reference (re-photographed later) each get their own event id', () => {
  const env = makeEnv();
  try {
    const first = createTrackingEvent({ reference: '5698-DELIV', photosSaved: 2 }, { queueDir: queueDir(env) });
    const second = createTrackingEvent({ reference: '5698-DELIV', photosSaved: 3 }, { queueDir: queueDir(env) });
    assert.notEqual(first.eventId, second.eventId);
    const pending = listPendingEvents(queueDir(env));
    assert.equal(pending.length, 2);
  } finally {
    env.cleanup();
  }
});

test('listPendingEvents on a queue folder that does not exist yet returns an empty list, not an error', () => {
  const env = makeEnv();
  try {
    assert.deepEqual(listPendingEvents(nodePath.join(env.home, 'never-created')), []);
  } finally {
    env.cleanup();
  }
});

test('a corrupted queue file is skipped rather than hiding every other pending event', () => {
  const env = makeEnv();
  try {
    const dir = queueDir(env);
    createTrackingEvent({ reference: '5698-DELIV', photosSaved: 1 }, { queueDir: dir });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, 'garbage.json'), '{ not valid json');
    const pending = listPendingEvents(dir);
    assert.equal(pending.length, 1);
  } finally {
    env.cleanup();
  }
});

test('removeEvent deletes the one file for that event, and is safe to call twice', () => {
  const env = makeEnv();
  try {
    const dir = queueDir(env);
    const record = createTrackingEvent({ reference: '5698-DELIV', photosSaved: 1 }, { queueDir: dir });
    removeEvent(dir, record.eventId);
    assert.deepEqual(listPendingEvents(dir), []);
    assert.doesNotThrow(() => removeEvent(dir, record.eventId));
  } finally {
    env.cleanup();
  }
});

test('a failed sync attempt is recorded on the event, and it remains pending', () => {
  const env = makeEnv();
  try {
    const dir = queueDir(env);
    const record = createTrackingEvent({ reference: '5698-DELIV', photosSaved: 1 }, { queueDir: dir });
    recordAttemptFailure(dir, record.eventId, 'network unreachable');
    recordAttemptFailure(dir, record.eventId, 'network unreachable again');

    const pending = listPendingEvents(dir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].attempts, 2);
    assert.match(pending[0].lastError, /network unreachable again/);
    assert.ok(pending[0].lastAttemptAt);
  } finally {
    env.cleanup();
  }
});

test('the queue survives a "restart" - a fresh read of the same folder sees everything already written', () => {
  const env = makeEnv();
  try {
    const dir = queueDir(env);
    const a = createTrackingEvent({ reference: '5698-DELIV', photosSaved: 2 }, { queueDir: dir });
    const b = createTrackingEvent({ reference: '5699-P-DELIV', photosSaved: 1 }, { queueDir: dir });

    // Nothing here holds any in-memory state between calls - every function
    // reads the directory fresh, exactly as it would after the app (or the
    // whole PC) restarted.
    const pending = listPendingEvents(dir);
    assert.equal(pending.length, 2);
    assert.ok(pending.some((e) => e.eventId === a.eventId));
    assert.ok(pending.some((e) => e.eventId === b.eventId));
  } finally {
    env.cleanup();
  }
});

test('Saved Date/Time reflects when the event was created (i.e. when the session was confirmed complete), via an injected clock', () => {
  const env = makeEnv();
  try {
    const fixedNow = new Date('2026-10-02T14:30:00.000Z');
    const record = createTrackingEvent({ reference: '5698-DELIV', photosSaved: 1 }, { queueDir: queueDir(env), now: () => fixedNow });
    assert.equal(record.savedAt, fixedNow.toISOString());
  } finally {
    env.cleanup();
  }
});

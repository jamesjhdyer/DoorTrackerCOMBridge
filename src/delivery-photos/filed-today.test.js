'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { workshopDateKey, recordFiledSession, countOrdersFiledOn } = require('./filed-today');

function makeDir() {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'filed-today-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

let n = 0;
function file(dir, reference, savedAt) {
  recordFiledSession(dir, { eventId: `evt-${++n}`, reference, savedAt });
}

test('counts unique order numbers, not sessions or part deliveries', () => {
  const { dir, cleanup } = makeDir();
  try {
    const at = '2026-10-06T10:00:00.000Z';
    for (const ref of ['5698-DELIV', '5698-P-DELIV', '5698-P2-DELIV', '5701-DELIV', '5702-P-DELIV']) file(dir, ref, at);
    assert.equal(countOrdersFiledOn(dir, new Date('2026-10-06T15:00:00.000Z')), 3);
  } finally {
    cleanup();
  }
});

test('an order number containing its own hyphen is one order across its parts', () => {
  const { dir, cleanup } = makeDir();
  try {
    file(dir, '5626-2-DELIV', '2026-10-06T09:00:00.000Z');
    file(dir, '5626-2-P2-DELIV', '2026-10-06T11:00:00.000Z');
    assert.equal(countOrdersFiledOn(dir, new Date('2026-10-06T12:00:00.000Z')), 1);
  } finally {
    cleanup();
  }
});

test('the same session reported twice still counts its order once', () => {
  const { dir, cleanup } = makeDir();
  try {
    file(dir, '5698-DELIV', '2026-10-06T09:00:00.000Z');
    file(dir, '5698-DELIV', '2026-10-06T09:05:00.000Z');
    assert.equal(countOrdersFiledOn(dir, new Date('2026-10-06T12:00:00.000Z')), 1);
  } finally {
    cleanup();
  }
});

test('nothing filed yet today is zero, and yesterday never carries over', () => {
  const { dir, cleanup } = makeDir();
  try {
    assert.equal(countOrdersFiledOn(dir, new Date('2026-10-06T12:00:00.000Z')), 0);
    file(dir, '5698-DELIV', '2026-10-05T12:00:00.000Z');
    assert.equal(countOrdersFiledOn(dir, new Date('2026-10-06T12:00:00.000Z')), 0);
    assert.equal(countOrdersFiledOn(dir, new Date('2026-10-05T18:00:00.000Z')), 1);
  } finally {
    cleanup();
  }
});

test('"today" is the UK date, not the UTC date (British Summer Time)', () => {
  // 23:30 UTC on 5 Oct is 00:30 on 6 Oct in London (BST, UTC+1).
  assert.equal(workshopDateKey('2026-10-05T23:30:00.000Z'), '2026-10-06');
  // In winter (GMT) the two agree.
  assert.equal(workshopDateKey('2026-12-05T23:30:00.000Z'), '2026-12-05');

  const { dir, cleanup } = makeDir();
  try {
    file(dir, '5698-DELIV', '2026-10-05T23:30:00.000Z');
    assert.equal(countOrdersFiledOn(dir, new Date('2026-10-06T08:00:00.000Z')), 1);
    assert.equal(countOrdersFiledOn(dir, new Date('2026-10-05T22:00:00.000Z')), 0);
  } finally {
    cleanup();
  }
});

test('a corrupted line or an invalid reference does not hide the rest', () => {
  const { dir, cleanup } = makeDir();
  try {
    file(dir, '5698-DELIV', '2026-10-06T09:00:00.000Z');
    fs.appendFileSync(nodePath.join(dir, '2026-10-06.jsonl'), '{not json\n');
    file(dir, 'not-a-code', '2026-10-06T09:00:00.000Z');
    file(dir, '5701-DELIV', '2026-10-06T10:00:00.000Z');
    assert.equal(countOrdersFiledOn(dir, new Date('2026-10-06T12:00:00.000Z')), 2);
  } finally {
    cleanup();
  }
});

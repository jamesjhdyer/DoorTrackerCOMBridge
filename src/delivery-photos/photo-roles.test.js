'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PhotoRoles = require('./photo-roles');

const base = (role, input) => {
  const parsed = PhotoRoles.parseForRole(role, input);
  assert.equal(parsed.ok, true, `${role} ${JSON.stringify(input)}: ${parsed.reason}`);
  return parsed.baseOrder;
};

test('the three roles and their exact upper-case file-name suffixes', () => {
  assert.deepEqual(PhotoRoles.ROLE_KEYS, ['delivery', 'bench', 'ironmongery']);
  assert.equal(PhotoRoles.ROLES.delivery.suffix, 'DELIV');
  assert.equal(PhotoRoles.ROLES.bench.suffix, 'BENCH');
  assert.equal(PhotoRoles.ROLES.ironmongery.suffix, 'IRN');
  for (const bad of ['', 'Delivery', 'DELIV', 'admin', '__proto__', 'constructor', undefined, null, 1]) assert.equal(PhotoRoles.isRole(bad), false, String(bad));
});

test('Delivery: every existing delivery format resolves to its base order folder', () => {
  assert.equal(base('delivery', '5698-DELIV'), '5698');
  assert.equal(base('delivery', '5698-P-DELIV'), '5698');
  assert.equal(base('delivery', '5698-P2-DELIV'), '5698');
  assert.equal(base('delivery', '5698-P3-DELIV'), '5698');
  assert.equal(base('delivery', '5626-2-DELIV'), '5626-2');
  assert.equal(base('delivery', '5626-2-P2-DELIV'), '5626-2');
  assert.equal(base('delivery', '5626-2-P3-DELIV'), '5626-2');
});

test('Delivery: the full/part details still come from the delivery scan itself', () => {
  const part = PhotoRoles.parseForRole('delivery', '5698-p2-deliv');
  assert.equal(part.code, '5698-P2-DELIV', 'canonical upper-case form');
  assert.deepEqual([part.delivery.reference, part.delivery.orderNumber, part.delivery.type, part.delivery.partNumber], ['5698-P2-DELIV', '5698', 'part', 2]);
  const full = PhotoRoles.parseForRole('delivery', '5626-2-DELIV');
  assert.deepEqual([full.delivery.type, full.delivery.partNumber], ['standard', null]);
});

test('Bench: door and frame labels resolve to the base order, whatever the unit number', () => {
  assert.equal(base('bench', '5698-D-01'), '5698');
  assert.equal(base('bench', '5698-D-02'), '5698');
  assert.equal(base('bench', '5698-D-17'), '5698');
  assert.equal(base('bench', '5698-F-01'), '5698');
  assert.equal(base('bench', '5698-F-05'), '5698');
  assert.equal(base('bench', '5698-F-07'), '5698');
  assert.equal(base('bench', '5626-2-D-01'), '5626-2');
  assert.equal(base('bench', '5626-2-F-03'), '5626-2');
  assert.equal(base('bench', '5698-D-100'), '5698', 'a job with 100+ doors');
  assert.equal(base('bench', ' 5698-d-07 '), '5698', 'trimmed and case-normalised');

  const parsed = PhotoRoles.parseForRole('bench', '5626-2-D-07');
  assert.equal(parsed.code, '5626-2-D-07', 'the original scanned value is kept');
  assert.equal(parsed.delivery, null);
  assert.deepEqual(PhotoRoles.parseBenchLabel('5626-2-F-03'), { ok: true, code: '5626-2-F-03', baseOrder: '5626-2', section: 'F', unit: 3 });
});

test('Bench: malformed or non-label codes are rejected', () => {
  for (const bad of [
    '5698',
    '5698-D',
    '5698-F',
    '5698-D-1',
    '5698-D-00',
    '5698-D-12345',
    '5698-J-01',
    '5698-DF-01',
    '5698--D-01',
    '-D-01',
    'D-01',
    '5698-D-01-02',
    '5698-DELIV',
    '5698-P2-DELIV',
    '5698-D-01/../x',
    '..\\5698-D-01',
    '5698 D 01',
    'ABC-D-01',
    '',
    '   ',
    null
  ]) {
    assert.equal(PhotoRoles.parseForRole('bench', bad).ok, false, JSON.stringify(bad));
  }
});

test('Ironmongery: plain order numbers resolve to themselves', () => {
  assert.equal(base('ironmongery', '5698'), '5698');
  assert.equal(base('ironmongery', '5626-2'), '5626-2');
  assert.equal(base('ironmongery', ' 5626-2 '), '5626-2');
  assert.equal(PhotoRoles.parseForRole('ironmongery', '5698').code, '5698');
});

test('Ironmongery: malformed and path-like order numbers are rejected', () => {
  for (const bad of [
    '5698-IRN',
    '5698-DELIV',
    '5698-D-01',
    '../5698',
    '5698/..',
    '..\\..\\Windows',
    '5698\\evil',
    'C:\\5698',
    '\\\\server\\share',
    '5698.',
    '5698 ',
    'CON',
    'NUL',
    'COM1',
    '5698-',
    '-5698',
    '5626--2',
    '56 98',
    '5698%2F',
    '1'.repeat(21),
    '',
    undefined
  ]) {
    const parsed = PhotoRoles.parseForRole('ironmongery', bad);
    // "5698 " is fine once trimmed - everything else must be refused.
    if (bad === '5698 ') assert.equal(parsed.baseOrder, '5698');
    else assert.equal(parsed.ok, false, JSON.stringify(bad));
  }
});

test('the three grammars are disjoint: no code is valid for more than one role', () => {
  const samples = ['5698-DELIV', '5698-P-DELIV', '5698-P2-DELIV', '5626-2-P3-DELIV', '5698-D-01', '5698-F-07', '5626-2-D-01', '5698', '5626-2', '5698-IRN', '5698-BENCH'];
  for (const code of samples) {
    const valid = PhotoRoles.ROLE_KEYS.filter((role) => PhotoRoles.parseForRole(role, code).ok);
    assert.ok(valid.length <= 1, `${code} is valid for ${valid.join(' and ')}`);
  }
});

test('an unknown role accepts nothing', () => {
  for (const role of ['', 'admin', 'DELIVERY', undefined]) assert.equal(PhotoRoles.parseForRole(role, '5698').ok, false);
});

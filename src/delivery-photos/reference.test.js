'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodePath = require('node:path');

const { parse, describe: describeRef } = require('./reference');

test('standard deliveries', () => {
  const r = parse('5698-DELIV');
  assert.deepEqual(r, { ok: true, reference: '5698-DELIV', orderNumber: '5698', type: 'standard', partNumber: null });
  assert.equal(describeRef(r), 'Order 5698');
});

test('part delivery 1 is written with no number', () => {
  const r = parse('5698-P-DELIV');
  assert.deepEqual(r, { ok: true, reference: '5698-P-DELIV', orderNumber: '5698', type: 'part', partNumber: 1 });
  assert.equal(describeRef(r), 'Order 5698, part delivery 1');
});

test('part deliveries 2 through 99', () => {
  assert.deepEqual(parse('5698-P2-DELIV'), { ok: true, reference: '5698-P2-DELIV', orderNumber: '5698', type: 'part', partNumber: 2 });
  assert.deepEqual(parse('5698-P99-DELIV'), { ok: true, reference: '5698-P99-DELIV', orderNumber: '5698', type: 'part', partNumber: 99 });
});

test('order numbers with their own internal hyphen are not confused with the part marker', () => {
  assert.deepEqual(parse('5626-2-DELIV'), { ok: true, reference: '5626-2-DELIV', orderNumber: '5626-2', type: 'standard', partNumber: null });
  const r = parse('5626-2-P3-DELIV');
  assert.deepEqual(r, { ok: true, reference: '5626-2-P3-DELIV', orderNumber: '5626-2', type: 'part', partNumber: 3 });
  assert.equal(describeRef(r), 'Order 5626-2, part delivery 3');
});

test('lower case is accepted and normalised to the canonical upper-case form', () => {
  assert.equal(parse('5698-deliv').reference, '5698-DELIV');
  assert.equal(parse('5698-p2-deliv').reference, '5698-P2-DELIV');
  assert.equal(parse('  5698-DELIV  ').reference, '5698-DELIV', 'surrounding whitespace is trimmed');
});

test('rejected: "P1", a leading zero, P0, P100, and any other malformed part number', () => {
  for (const bad of ['5698-P1-DELIV', '5698-P02-DELIV', '5698-P0-DELIV', '5698-P100-DELIV', '5698-P-2-DELIV']) {
    const r = parse(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.reason, /^[A-Z]/);
  }
});

test('rejected: empty, too long, non-string, and codes that are not the right shape at all', () => {
  for (const bad of ['', '   ', null, undefined, 42, '5698', 'DELIV', '-DELIV', '5698-DELIVERY', '5698_DELIV', '5698 DELIV', 'x'.repeat(41) + '-DELIV']) {
    const r = parse(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test('rejected: anything that could be a path-traversal or injection attempt, however it is spelled', () => {
  for (const bad of ['../../etc-DELIV', '..-DELIV', '5698-DELIV/../x', '5698-DELIV\\x', '5698-DELIV:evil', '5698-DELIV\x00', '５６-DELIV']) {
    assert.equal(parse(bad).ok, false, JSON.stringify(bad));
  }
});

test('describe() on an invalid parse returns an empty string rather than throwing', () => {
  assert.equal(describeRef(parse('not-a-code')), '');
  assert.equal(describeRef(null), '');
});

test('the module also works loaded as a plain <script> with no module system (as the iPad web app loads it)', () => {
  const source = fs.readFileSync(nodePath.join(__dirname, 'reference.js'), 'utf8');
  const sandbox = {}; // a bare global object, with no `module`/`exports` - a real browser <script> context
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.equal(typeof sandbox.DeliveryReference, 'object', 'must attach itself to the global object when there is no module system');
  assert.deepEqual(sandbox.DeliveryReference.parse('5698-DELIV').reference, '5698-DELIV');
});

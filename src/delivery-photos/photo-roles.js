// The three photo roles an iPad can be paired as - Delivery, Bench and
// Ironmongery - and the ONE grammar per role that decides which scanned
// codes that role accepts and which base order a code belongs to.
//
// Like reference.js, this file works unchanged in the iPad web app (a plain
// <script>, loaded after reference.js, exposing window.PhotoRoles) and in
// the Windows worker (require()) - so the iPad and the PC can never disagree
// about which codes are valid, or about which order folder a code files into.
//
// What the iPad does with this file is cosmetic only (labels, early "that is
// not a door label" feedback). The PC always re-parses the scanned code
// itself, using the role stored against the iPad's pairing token - never a
// role the iPad claims - see http-server.js.
//
// Grammars (all anchored, upper-case after normalising; <ORDER> is one or
// more digit groups joined by single hyphens, e.g. "5698" or "5626-2" -
// exactly reference.js's order-number grammar):
//   Delivery     reference.js unchanged: <ORDER>-DELIV, <ORDER>-P-DELIV,
//                <ORDER>-P<n>-DELIV (n 2-99)
//   Bench        <ORDER>-D or <ORDER>-F - a door or frame production
//                label, e.g. "5698-D" or "5626-2-F". No door/frame number
//                after the letter: every Bench photo of an order files into
//                the same order folder anyway.
//   Ironmongery  <ORDER> on its own, e.g. "5698" or "5626-2"
// The three grammars are disjoint - no code is valid for two roles - so a
// code scanned under one role can never be filed as another.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./reference'));
  } else {
    root.PhotoRoles = factory(root.DeliveryReference);
  }
})(typeof self !== 'undefined' ? self : this, function (DeliveryReference) {
  // `suffix` is the exact, upper-case file-name suffix: 001-DELIV.jpg,
  // 002-BENCH.jpg, 003-IRN.jpg. Everything else is wording for the screens.
  const ROLES = Object.freeze({
    delivery: Object.freeze({
      key: 'delivery',
      label: 'Delivery',
      suffix: 'DELIV',
      heading: 'DELIVERY PHOTOS',
      instruction: 'Scan delivery code',
      scannedLabel: 'Delivery',
      inputLabel: 'Delivery code',
      placeholder: '5698-DELIV',
      example: '5698-DELIV'
    }),
    bench: Object.freeze({
      key: 'bench',
      label: 'Bench',
      suffix: 'BENCH',
      heading: 'BENCH PHOTOS',
      instruction: 'Scan a door or frame label',
      scannedLabel: 'Scanned',
      inputLabel: 'Door or frame label',
      placeholder: '5698-D',
      example: '5698-D or 5698-F'
    }),
    ironmongery: Object.freeze({
      key: 'ironmongery',
      label: 'Ironmongery',
      suffix: 'IRN',
      heading: 'IRONMONGERY PHOTOS',
      instruction: 'Scan or enter order number',
      scannedLabel: 'Order',
      inputLabel: 'Order number',
      placeholder: '5698',
      example: '5698 or 5626-2'
    })
  });

  const ROLE_KEYS = Object.freeze(Object.keys(ROLES));
  const SUFFIXES = Object.freeze(ROLE_KEYS.map((key) => ROLES[key].suffix));

  // Order numbers are short in real life ("5698", "5626-2"); this is a sanity
  // cap, well inside the archive's own folder-name length limit.
  const MAX_ORDER_LENGTH = 20;
  const MAX_CODE_LENGTH = 40;
  const ORDER_PATTERN = /^[0-9]+(?:-[0-9]+)*$/;
  const BENCH_PATTERN = /^([0-9]+(?:-[0-9]+)*)-([DF])$/;

  function isRole(role) {
    return typeof role === 'string' && Object.prototype.hasOwnProperty.call(ROLES, role);
  }

  function normalise(input) {
    if (typeof input !== 'string') return { ok: false, reason: 'Not a text value.' };
    const trimmed = input.trim();
    if (!trimmed) return { ok: false, reason: 'Empty.' };
    if (trimmed.length > MAX_CODE_LENGTH) return { ok: false, reason: `Longer than ${MAX_CODE_LENGTH} characters.` };
    return { ok: true, value: trimmed.toUpperCase() };
  }

  function checkOrder(order) {
    if (order.length > MAX_ORDER_LENGTH) return `The order number is longer than ${MAX_ORDER_LENGTH} characters.`;
    return '';
  }

  // "5698" / "5626-2" -> { ok, baseOrder } | { ok: false, reason }.
  function parseOrderNumber(input) {
    const n = normalise(input);
    if (!n.ok) return n;
    if (!ORDER_PATTERN.test(n.value)) return { ok: false, reason: 'Does not look like an order number (expected something like 5698 or 5626-2).' };
    const problem = checkOrder(n.value);
    if (problem) return { ok: false, reason: problem };
    return { ok: true, baseOrder: n.value };
  }

  // "5698-D" / "5626-2-F" -> { ok, code, baseOrder, section: 'D'|'F' }.
  function parseBenchLabel(input) {
    const n = normalise(input);
    if (!n.ok) return n;
    const match = BENCH_PATTERN.exec(n.value);
    if (!match) return { ok: false, reason: 'Does not look like a door or frame label (expected something like 5698-D or 5698-F).' };
    const [, baseOrder, section] = match;
    const problem = checkOrder(baseOrder);
    if (problem) return { ok: false, reason: problem };
    return { ok: true, code: n.value, baseOrder, section };
  }

  // The one entry point both sides use: what does `role` make of `input`?
  // Returns { ok: true, role, code, baseOrder, delivery } where `code` is the
  // canonical scanned value (what the iPad sends, and what the PC re-parses),
  // `baseOrder` is the order folder name, and `delivery` is reference.js's
  // full parse for a Delivery code (null otherwise) - the Full/Part details
  // the Google Sheet needs, which never come from a file name.
  function parseForRole(role, input) {
    if (!isRole(role)) return { ok: false, reason: 'This iPad has no photo role.' };

    if (role === 'delivery') {
      const parsed = DeliveryReference.parse(input);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      const problem = checkOrder(parsed.orderNumber);
      if (problem) return { ok: false, reason: problem };
      return { ok: true, role, code: parsed.reference, baseOrder: parsed.orderNumber, delivery: parsed };
    }

    if (role === 'bench') {
      const parsed = parseBenchLabel(input);
      if (!parsed.ok) return parsed;
      return { ok: true, role, code: parsed.code, baseOrder: parsed.baseOrder, delivery: null };
    }

    const parsed = parseOrderNumber(input);
    if (!parsed.ok) return parsed;
    return { ok: true, role, code: parsed.baseOrder, baseOrder: parsed.baseOrder, delivery: null };
  }

  function roleInfo(role) {
    return isRole(role) ? ROLES[role] : null;
  }

  return { ROLES, ROLE_KEYS, SUFFIXES, MAX_ORDER_LENGTH, isRole, roleInfo, parseOrderNumber, parseBenchLabel, parseForRole };
});

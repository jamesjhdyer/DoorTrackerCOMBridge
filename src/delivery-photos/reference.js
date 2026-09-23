// Parses and validates a delivery reference such as "5698-DELIV",
// "5698-P-DELIV", "5698-P2-DELIV" or "5626-2-P3-DELIV" - this is the ENTIRE
// content of the Data Matrix on a delivery note (no website URL, no domain),
// and is also the exact folder name the photographs end up filed in.
//
// This file works unchanged in both the iPad web app (loaded as a plain
// <script>, no bundler) and the Windows worker (loaded with require()) - see
// the export lines at the bottom. Keeping it as ONE file used by both sides
// is deliberate: the iPad and the Windows PC must always agree on exactly
// which codes are valid, with no risk of the two copies drifting apart.
//
// Grammar:
//   <ORDER>-DELIV            standard delivery
//   <ORDER>-P-DELIV          part delivery 1
//   <ORDER>-P<n>-DELIV       part delivery n (2-99)
//   <ORDER> is one or more upper-case letter/digit groups joined by single
//   hyphens (e.g. "5698", "5626-2") - so the order number's OWN hyphen is
//   never confused with the "-P2-" / "-DELIV" markers. "P1", a leading zero
//   in the part number, or any other malformed shape is rejected.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DeliveryReference = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_LENGTH = 40;
  // The order number is one or more DIGIT groups joined by single hyphens
  // (capture 1: real order numbers are always numeric, e.g. "5698" or
  // "5626-2" - never letters, which is what lets "P" be recognised
  // unambiguously as the part marker below rather than a possible order-
  // number segment). Then an OPTIONAL "-P" + digits (capture 2 - undefined
  // when the whole optional group is absent, empty string for "-P" with no
  // number at all), then the literal "-DELIV". Anchored, upper-case only
  // (the caller decides whether/how to normalise case before parsing - see
  // parse()). A single explicit pattern like this - rather than matching
  // everything before "-DELIV" loosely and re-parsing that substring
  // separately - is deliberate: an earlier two-pass version could silently
  // treat a malformed part marker (e.g. "5698-P-2-DELIV") as if "P-2" were
  // just an ordinary order-number segment, instead of rejecting it.
  const PATTERN = /^([0-9]+(?:-[0-9]+)*)(?:-P([0-9]*))?-DELIV$/;

  // Returns { ok: true, reference, orderNumber, type: 'standard' | 'part', partNumber }
  // or { ok: false, reason }. `reference` is always the canonical (upper-case)
  // form - also the exact folder name to file photographs under.
  function parse(input) {
    if (typeof input !== 'string') return { ok: false, reason: 'Not a text value.' };
    const trimmed = input.trim();
    if (!trimmed) return { ok: false, reason: 'Empty.' };
    if (trimmed.length > MAX_LENGTH) return { ok: false, reason: `Longer than ${MAX_LENGTH} characters.` };

    const upper = trimmed.toUpperCase();
    const match = PATTERN.exec(upper);
    if (!match) return { ok: false, reason: 'Does not look like a delivery code (expected something like 5698-DELIV).' };

    const [, orderNumber, partDigits] = match;

    if (partDigits === undefined) {
      return { ok: true, reference: upper, orderNumber, type: 'standard', partNumber: null };
    }
    if (partDigits === '') {
      // "-P-DELIV" with no number at all means part 1.
      return { ok: true, reference: upper, orderNumber, type: 'part', partNumber: 1 };
    }
    if (partDigits === '1' || /^0/.test(partDigits)) {
      return { ok: false, reason: 'Part 1 is written as "-P-DELIV" (no number), and part numbers never start with a zero.' };
    }
    const partNumber = Number(partDigits);
    if (partNumber < 2 || partNumber > 99) {
      return { ok: false, reason: 'The part number must be from 2 to 99.' };
    }
    return { ok: true, reference: upper, orderNumber, type: 'part', partNumber };
  }

  // A short, friendly line for the iPad screen, e.g. "Order 5698" or
  // "Order 5626-2, part delivery 3".
  function describe(parsed) {
    if (!parsed || !parsed.ok) return '';
    return parsed.type === 'part' ? `Order ${parsed.orderNumber}, part delivery ${parsed.partNumber}` : `Order ${parsed.orderNumber}`;
  }

  return { parse, describe, MAX_LENGTH };
});

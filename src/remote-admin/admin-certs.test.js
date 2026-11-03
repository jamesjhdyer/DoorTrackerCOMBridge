'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const { ensureAdminCertificates, readCaFingerprint } = require('./admin-certs');
const { certSubjectAltNames } = require('../delivery-photos/certs');

test('the certificate covers the computer name, its .local name and LAN addresses, signed by one lasting CA', () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'ra-certs-'));
  try {
    assert.equal(readCaFingerprint(dir), null);
    const first = ensureAdminCertificates(dir, { primary: 'workshop-pc', extra: ['workshop-pc.local', '192.168.1.40'] });
    const names = certSubjectAltNames(first.cert);
    for (const name of ['workshop-pc', 'workshop-pc.local', '192.168.1.40', 'localhost', '127.0.0.1']) assert.ok(names.includes(name), name);
    assert.ok(new crypto.X509Certificate(first.cert).verify(new crypto.X509Certificate(first.caCert).publicKey));
    assert.equal(readCaFingerprint(dir), first.caFingerprint);

    // Unchanged names: the same certificate is reused.
    assert.equal(ensureAdminCertificates(dir, { primary: 'workshop-pc', extra: ['workshop-pc.local', '192.168.1.40'] }).cert, first.cert);

    // A new DHCP address: a new certificate, from the SAME CA (so a browser that trusts it keeps trusting it).
    const moved = ensureAdminCertificates(dir, { primary: 'workshop-pc', extra: ['workshop-pc.local', '192.168.1.77'] });
    assert.notEqual(moved.cert, first.cert);
    assert.ok(certSubjectAltNames(moved.cert).includes('192.168.1.77'));
    assert.equal(moved.caFingerprint, first.caFingerprint);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

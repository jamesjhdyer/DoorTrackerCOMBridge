'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const https = require('node:https');
const forge = require('node-forge');

const { ensureCertificates, buildTrustProfileMobileConfig, certExpiresWithinDays, certSubjectAltNames } = require('./certs');

function scratch() {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'dp-certs-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test('generates a CA and a leaf certificate on first use', () => {
  const s = scratch();
  try {
    const result = ensureCertificates(s.dir, 'door-tracker.local');
    assert.match(result.key, /BEGIN (RSA )?PRIVATE KEY/);
    assert.match(result.cert, /BEGIN CERTIFICATE/);
    assert.match(result.caCert, /BEGIN CERTIFICATE/);
    for (const name of ['ca-key.pem', 'ca-cert.pem', 'leaf-key.pem', 'leaf-cert.pem']) {
      assert.ok(fs.existsSync(nodePath.join(s.dir, name)), name);
    }
  } finally {
    s.cleanup();
  }
});

test('the leaf certificate covers the configured hostname, plus localhost for this same PC', () => {
  const s = scratch();
  try {
    const result = ensureCertificates(s.dir, 'door-tracker.local');
    const names = certSubjectAltNames(result.cert);
    assert.ok(names.includes('door-tracker.local'));
    assert.ok(names.includes('localhost'));
    assert.ok(names.includes('127.0.0.1'));
  } finally {
    s.cleanup();
  }
});

test('a real TLS handshake succeeds when the client trusts only the generated CA - not the system trust store', async () => {
  const s = scratch();
  try {
    const { key, cert, caCert } = ensureCertificates(s.dir, 'door-tracker.local');
    const server = https.createServer({ key, cert }, (req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const body = await new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port, path: '/', ca: caCert, servername: 'door-tracker.local' }, (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      assert.equal(body, 'ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    s.cleanup();
  }
});

test('a client that does NOT trust the generated CA is rejected - this is not accidentally wide open', async () => {
  const s = scratch();
  try {
    const { key, cert } = ensureCertificates(s.dir, 'door-tracker.local');
    const server = https.createServer({ key, cert }, (req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      await assert.rejects(
        new Promise((resolve, reject) => {
          https.get({ host: '127.0.0.1', port, path: '/', servername: 'door-tracker.local' }, resolve).on('error', reject);
        })
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    s.cleanup();
  }
});

test('calling it again with the same hostname keeps the same CA (an iPad only ever needs to trust it once)', () => {
  const s = scratch();
  try {
    const first = ensureCertificates(s.dir, 'door-tracker.local');
    const second = ensureCertificates(s.dir, 'door-tracker.local');
    assert.equal(second.caCert, first.caCert);
    assert.equal(second.cert, first.cert, 'an already-valid, already-matching leaf is not needlessly regenerated either');
  } finally {
    s.cleanup();
  }
});

test('changing the hostname reissues the leaf, signed by the SAME already-trusted CA', () => {
  const s = scratch();
  try {
    const first = ensureCertificates(s.dir, 'door-tracker.local');
    const second = ensureCertificates(s.dir, 'workshop-photos.local');
    assert.equal(second.caCert, first.caCert, 'the CA must never change just because the hostname did');
    assert.notEqual(second.cert, first.cert);
    assert.ok(certSubjectAltNames(second.cert).includes('workshop-photos.local'));
    assert.ok(!certSubjectAltNames(second.cert).includes('door-tracker.local'));
  } finally {
    s.cleanup();
  }
});

test('certExpiresWithinDays correctly judges a freshly issued (2-year) certificate', () => {
  const s = scratch();
  try {
    const { cert } = ensureCertificates(s.dir, 'door-tracker.local');
    assert.equal(certExpiresWithinDays(cert, 1), false, 'a brand new certificate is not about to expire tomorrow');
    assert.equal(certExpiresWithinDays(cert, 3651), true, 'but it is well within any window longer than its own validity');
  } finally {
    s.cleanup();
  }
});

test('the trust-profile .mobileconfig is well-formed, embeds only the CA certificate, and never the private key', () => {
  const s = scratch();
  try {
    const { caCert, key } = ensureCertificates(s.dir, 'door-tracker.local');
    const profile = buildTrustProfileMobileConfig(caCert);

    assert.match(profile, /^<\?xml version="1\.0"/);
    assert.match(profile, /<key>PayloadType<\/key>\s*\n\s*<string>com\.apple\.security\.root<\/string>/);
    assert.match(profile, /<key>PayloadContent<\/key>/);

    // The embedded base64 blob must decode back to exactly the CA's DER bytes - proving
    // it really is that certificate, not placeholder or malformed data.
    const embedded = /<data>([\s\S]*?)<\/data>/.exec(profile)[1].trim();
    const decodedDer = Buffer.from(embedded, 'base64');
    const expectedDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(caCert))).getBytes(), 'binary');
    assert.ok(decodedDer.equals(expectedDer));

    // The private key must never appear anywhere in a document meant to be handed to a device.
    const keyFingerprint = key.split('\n')[1]; // a line from the middle of the PEM body
    assert.ok(!profile.includes(keyFingerprint));
  } finally {
    s.cleanup();
  }
});

'use strict';

// Local HTTPS, trusted by the iPad, with no internet involved.
//
// getUserMedia (the camera) only works in a "secure context" - HTTPS, full
// stop; a plain http://192.168.x.x address does not qualify on any modern
// browser, iPad Safari included. And on iOS specifically, just clicking
// through a self-signed-certificate warning is not enough for a secure
// context to actually take effect (confirmed in research before writing
// this file) - the certificate has to be genuinely trusted by the device.
//
// So this program is its own tiny certificate authority: it creates ONE
// root CA (once, kept for years) and signs a leaf certificate for the
// configured local hostname. The CA's certificate - never its private key -
// is what gets installed on each iPad, as a one-time step (see
// buildTrustProfile below); every leaf this program ever issues after that
// is automatically trusted too, with a real, un-scary HTTPS padlock.
//
// Nothing here talks to the internet and no external certificate authority
// is involved - this is not "real" TLS in the public sense, it is a private
// trust relationship this program creates and controls entirely.

const fs = require('node:fs');
const nodePath = require('node:path');
const forge = require('node-forge');
const { certsDir } = require('./paths');

const CA_VALIDITY_YEARS = 10;
const LEAF_VALIDITY_YEARS = 2;
// Regenerate the leaf well before it actually expires, so there is never a
// moment where an unattended PC is serving an expired certificate.
const LEAF_RENEW_BEFORE_DAYS = 60;

const CA_COMMON_NAME = 'Door Tracker Local Trust';
const PROFILE_IDENTIFIER = 'com.doortracker.combridge.local-trust';

function paths(dir) {
  return {
    caKey: nodePath.join(dir, 'ca-key.pem'),
    caCert: nodePath.join(dir, 'ca-cert.pem'),
    leafKey: nodePath.join(dir, 'leaf-key.pem'),
    leafCert: nodePath.join(dir, 'leaf-cert.pem')
  };
}

function randomSerial() {
  // Must be a positive integer in hex, per X.509 - a leading 00 avoids it
  // ever being misread as negative (high bit set) by a strict parser.
  return `00${forge.util.bytesToHex(forge.random.getBytesSync(16))}`;
}

function generateCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + CA_VALIDITY_YEARS);

  const attrs = [{ name: 'commonName', value: CA_COMMON_NAME }, { name: 'organizationName', value: 'Door Tracker (local only, not a public authority)' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: false, critical: true },
    { name: 'subjectKeyIdentifier' }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return { keyPem: forge.pki.privateKeyToPem(keys.privateKey), certPem: forge.pki.certificateToPem(cert) };
}

function generateLeaf(hostname, caKeyPem, caCertPem) {
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const caCert = forge.pki.certificateFromPem(caCertPem);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + LEAF_VALIDITY_YEARS);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    // iOS requires the SAN to match the address in the URL bar - a bare
    // CommonName is not enough on its own. localhost/127.0.0.1 are included
    // too, purely so this program's own machine can also reach the local
    // server directly (for the "Test Network Storage" style checks) without
    // needing a second certificate.
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }, { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
    { name: 'subjectKeyIdentifier' }
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  return { keyPem: forge.pki.privateKeyToPem(keys.privateKey), certPem: forge.pki.certificateToPem(cert) };
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function writeSecret(filePath, contents) {
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
}

function certExpiresWithinDays(certPem, days) {
  const cert = forge.pki.certificateFromPem(certPem);
  return cert.validity.notAfter.getTime() - Date.now() < days * 24 * 3600 * 1000;
}

function certSubjectAltNames(certPem) {
  const cert = forge.pki.certificateFromPem(certPem);
  const ext = cert.getExtension('subjectAltName');
  // For an IP-type entry, forge's parsed `.value` is the raw address BYTES, not
  // text - `.ip` is the human-readable dotted-decimal form, and must be checked
  // first (an IP entry's `.value` is non-empty too, so `.value || .ip` would
  // never reach `.ip` at all).
  return ext ? ext.altNames.map((a) => a.ip || a.value) : [];
}

// Creates the CA and a leaf certificate for `hostname` if either is missing,
// and reissues the leaf (using the SAME, already-trusted CA) whenever the
// hostname has changed or the leaf is due to expire soon. Returns
// { key, cert } PEM strings ready for https.createServer/createSecureContext.
// A CA is only ever created once per install - recreating it would mean
// every iPad has to install the trust profile again, so this function goes
// out of its way never to do that unless the CA file is simply missing.
function ensureCertificates(dir = certsDir(), hostname) {
  const p = paths(dir);
  let caKeyPem = readIfExists(p.caKey);
  let caCertPem = readIfExists(p.caCert);
  if (!caKeyPem || !caCertPem) {
    const ca = generateCa();
    caKeyPem = ca.keyPem;
    caCertPem = ca.certPem;
    writeSecret(p.caKey, caKeyPem);
    writeSecret(p.caCert, caCertPem);
  }

  let leafKeyPem = readIfExists(p.leafKey);
  let leafCertPem = readIfExists(p.leafCert);
  const needsNewLeaf = !leafKeyPem || !leafCertPem || !certSubjectAltNames(leafCertPem).includes(hostname) || certExpiresWithinDays(leafCertPem, LEAF_RENEW_BEFORE_DAYS);
  if (needsNewLeaf) {
    const leaf = generateLeaf(hostname, caKeyPem, caCertPem);
    leafKeyPem = leaf.keyPem;
    leafCertPem = leaf.certPem;
    writeSecret(p.leafKey, leafKeyPem);
    writeSecret(p.leafCert, leafCertPem);
  }

  return { key: leafKeyPem, cert: leafCertPem, caCert: caCertPem };
}

// The one-time trust step: a valid Apple configuration profile embedding
// only the CA's CERTIFICATE (never its private key). Opened in Safari on
// the iPad, this offers "Install Profile" directly - no other app needed.
// After installing it, the person still has to flip ONE toggle themselves
// (Settings > General > About > Certificate Trust Settings > full trust for
// "Door Tracker Local Trust") - Apple deliberately does not allow a profile
// to enable that automatically, so this program cannot skip that step
// either, only make everything up to it as simple as a single tap.
function buildTrustProfileMobileConfig(caCertPem) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(caCertPem))).getBytes();
  const base64 = Buffer.from(der, 'binary').toString('base64');
  const payloadUuid = randomUuidLike();
  const profileUuid = randomUuidLike();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>door-tracker-local-trust.cer</string>
      <key>PayloadContent</key>
      <data>${base64}</data>
      <key>PayloadDescription</key>
      <string>Trusts this workshop PC's Delivery Photos service so the iPad can use its camera.</string>
      <key>PayloadDisplayName</key>
      <string>${CA_COMMON_NAME}</string>
      <key>PayloadIdentifier</key>
      <string>${PROFILE_IDENTIFIER}.cert</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${payloadUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Lets this iPad use the Delivery Photos camera tool on the workshop network. Installs no other settings and grants no other access.</string>
  <key>PayloadDisplayName</key>
  <string>Door Tracker Delivery Photos - Local Trust</string>
  <key>PayloadIdentifier</key>
  <string>${PROFILE_IDENTIFIER}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

function randomUuidLike() {
  return require('node:crypto').randomUUID().toUpperCase();
}

module.exports = { ensureCertificates, buildTrustProfileMobileConfig, certExpiresWithinDays, certSubjectAltNames, CA_COMMON_NAME };

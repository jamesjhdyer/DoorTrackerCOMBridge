'use strict';

// Remote Admin's HTTPS certificate. Made with exactly the same code as
// Delivery Photos' (../delivery-photos/certs.js - a tiny local certificate
// authority plus a certificate it signs), but kept in Remote Admin's own
// folder: the admin page is reached by this PC's computer name or LAN
// address from a desktop browser, not by the iPads' .local name, and it must
// keep working whether or not Delivery Photos is set up or running.
//
// Nothing here is a publicly trusted certificate. To avoid a browser warning
// on the upstairs PC, its CA certificate (public half only - served at
// /admin/ca.crt) can be imported there; the Windows app shows its SHA-256
// fingerprint so it can be checked before trusting it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const nodePath = require('node:path');
const { generateCa, generateLeaf, certSubjectAltNames, certExpiresWithinDays } = require('../delivery-photos/certs');
const { computerName, fullHostName, localIpv4Addresses } = require('./net-guard');

const LEAF_RENEW_BEFORE_DAYS = 60;

function files(dir) {
  return {
    caKey: nodePath.join(dir, 'ca-key.pem'),
    caCert: nodePath.join(dir, 'ca-cert.pem'),
    leafKey: nodePath.join(dir, 'leaf-key.pem'),
    leafCert: nodePath.join(dir, 'leaf-cert.pem')
  };
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

// Every name the certificate should be valid for, right now: the computer
// name, computer-name.local, the full DNS name if the PC has one, and each
// LAN IPv4 address (localhost and 127.0.0.1 are always added by generateLeaf
// itself).
function desiredNames() {
  const name = computerName();
  const full = fullHostName();
  const extra = [...(name ? [`${name}.local`] : []), ...(full && full !== `${name}.local` ? [full] : []), ...localIpv4Addresses()];
  return { primary: name || 'localhost', extra };
}

function caFingerprint(caCertPem) {
  return new crypto.X509Certificate(caCertPem).fingerprint256;
}

// Creates the CA once, ever, and (re)issues the server certificate whenever
// it is missing, near expiry, or no longer covers one of this PC's current
// names/addresses (e.g. the laptop was given a new IP address).
function ensureAdminCertificates(dir, names = desiredNames()) {
  const p = files(dir);
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
  const wanted = [names.primary, ...names.extra];
  const needsNewLeaf = !leafKeyPem || !leafCertPem || !wanted.every((n) => certSubjectAltNames(leafCertPem).includes(n)) || certExpiresWithinDays(leafCertPem, LEAF_RENEW_BEFORE_DAYS);
  if (needsNewLeaf) {
    const leaf = generateLeaf(names.primary, caKeyPem, caCertPem, names.extra.filter((n) => n !== names.primary && n !== 'localhost'));
    leafKeyPem = leaf.keyPem;
    leafCertPem = leaf.certPem;
    writeSecret(p.leafKey, leafKeyPem);
    writeSecret(p.leafCert, leafCertPem);
  }

  return { key: leafKeyPem, cert: leafCertPem, caCert: caCertPem, caFingerprint: caFingerprint(caCertPem) };
}

// The CA's fingerprint for the Windows app to display, or null before one exists.
function readCaFingerprint(dir) {
  const pem = readIfExists(files(dir).caCert);
  try {
    return pem ? caFingerprint(pem) : null;
  } catch {
    return null;
  }
}

module.exports = { ensureAdminCertificates, readCaFingerprint, desiredNames };

'use strict';

// The iPad tool's "app shell": every file it needs to start, scan a Data
// Matrix or QR code, take photographs and queue them - with NO connection to this
// PC at all (the iPad away from the workshop Wi-Fi). The iPad's Service
// Worker (delivery-photos-web/sw.js) keeps a copy of exactly these files.
//
// /sw.js is served with this list and a version stamp - a SHA-256 over the
// contents of every file in it - filled in. Any change to any of these files
// (a new Windows build) therefore changes sw.js itself, which is what makes
// the iPad fetch the new set the next time it opens the tool on the workshop
// network. Nothing has to be bumped by hand.

const fs = require('node:fs');
const nodePath = require('node:path');
const { createHash } = require('node:crypto');

const WEB_ROOT = nodePath.join(__dirname, '..', '..', 'delivery-photos-web');

// URL path -> file on disk. reference.js and photo-roles.js are the files served from the
// server's own code rather than the web root (see http-server.js).
const SHELL_FILES = {
  '/': nodePath.join(WEB_ROOT, 'index.html'),
  '/style.css': nodePath.join(WEB_ROOT, 'style.css'),
  '/app.js': nodePath.join(WEB_ROOT, 'app.js'),
  '/camera.js': nodePath.join(WEB_ROOT, 'camera.js'),
  '/scanner.js': nodePath.join(WEB_ROOT, 'scanner.js'),
  '/offline-queue.js': nodePath.join(WEB_ROOT, 'offline-queue.js'),
  '/reference.js': nodePath.join(__dirname, 'reference.js'),
  '/photo-roles.js': nodePath.join(__dirname, 'photo-roles.js'),
  '/vendor/zxing/zxing-reader.js': nodePath.join(WEB_ROOT, 'vendor', 'zxing', 'zxing-reader.js'),
  '/vendor/zxing/zxing_reader.wasm': nodePath.join(WEB_ROOT, 'vendor', 'zxing', 'zxing_reader.wasm'),
  '/manifest.webmanifest': nodePath.join(WEB_ROOT, 'manifest.webmanifest'),
  '/icon-180.png': nodePath.join(WEB_ROOT, 'icon-180.png'),
  '/icon-512.png': nodePath.join(WEB_ROOT, 'icon-512.png')
};

function shellVersion() {
  const hash = createHash('sha256');
  for (const [urlPath, filePath] of Object.entries(SHELL_FILES)) {
    hash.update(urlPath);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

// The Service Worker script with its placeholders filled in. Computed once
// per process (the files cannot change while this build is running).
let cachedServiceWorker = null;
function serviceWorkerSource() {
  if (!cachedServiceWorker) {
    const template = fs.readFileSync(nodePath.join(WEB_ROOT, 'sw.js'), 'utf8');
    cachedServiceWorker = template
      .replace("'__SHELL_VERSION__'", JSON.stringify(shellVersion()))
      .replace("'__SHELL_FILES__'", JSON.stringify(Object.keys(SHELL_FILES)));
  }
  return cachedServiceWorker;
}

module.exports = { SHELL_FILES, shellVersion, serviceWorkerSource };

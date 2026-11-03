#!/usr/bin/env node
'use strict';

// Run by CI right after `npm run dist:win` (see .github/workflows/build-windows.yml):
// checks the BUILT Windows package, not the source tree, for the things a
// packaging mistake would silently drop and no unit test would notice -
//   - the release assets the in-app updater looks for, under the exact names
//     src/updater/releases.js expects;
//   - latest.yml naming that installer, with a SHA-512 that really matches it
//     (what electron-updater verifies every download against);
//   - app-update.yml inside the app;
//   - the updater, Remote Admin (including its web page) and shared COM code
//     inside app.asar, and electron-updater itself.
// Exits non-zero, listing every problem, if anything is missing or wrong.
//
//   node scripts/verify-package.js [distDir]

const crypto = require('node:crypto');
const fs = require('node:fs');
const nodePath = require('node:path');
const asar = require('@electron/asar');
const { installerName } = require('../src/updater/releases');

const root = nodePath.join(__dirname, '..');
const dist = nodePath.resolve(process.argv[2] || nodePath.join(root, 'dist'));
const { version } = require('../package.json');
const problems = [];

function check(condition, message) {
  if (!condition) problems.push(message);
  return condition;
}

const setup = installerName(version);
const assets = [setup, `${setup}.blockmap`, 'latest.yml', `DoorTrackerCOMBridge-Portable-${version}.exe`];
for (const name of assets) check(fs.existsSync(nodePath.join(dist, name)), `Missing release asset: dist/${name}`);

const latestPath = nodePath.join(dist, 'latest.yml');
if (fs.existsSync(latestPath) && fs.existsSync(nodePath.join(dist, setup))) {
  const yml = fs.readFileSync(latestPath, 'utf8');
  check(new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(yml), `latest.yml is not for version ${version}`);
  check(yml.includes(`- url: ${setup}\n`), `latest.yml does not name ${setup}`);
  const declared = /^\s+sha512: (\S+)$/m.exec(yml);
  const actual = crypto.createHash('sha512').update(fs.readFileSync(nodePath.join(dist, setup))).digest('base64');
  check(declared && declared[1] === actual, `latest.yml's SHA-512 does not match ${setup}`);
}

const resources = nodePath.join(dist, 'win-unpacked', 'resources');
const updateConfig = nodePath.join(resources, 'app-update.yml');
if (check(fs.existsSync(updateConfig), 'Missing win-unpacked/resources/app-update.yml')) {
  const text = fs.readFileSync(updateConfig, 'utf8');
  check(/owner: jamesjhdyer/.test(text) && /repo: DoorTrackerCOMBridge/.test(text), 'app-update.yml does not point at jamesjhdyer/DoorTrackerCOMBridge');
}

const asarPath = nodePath.join(resources, 'app.asar');
if (check(fs.existsSync(asarPath), 'Missing win-unpacked/resources/app.asar')) {
  const files = new Set(asar.listPackage(asarPath).map((f) => f.split(nodePath.sep).join('/')));
  const required = [
    '/src/main.js',
    '/src/preload.js',
    '/src/index.html',
    '/src/renderer.js',
    '/src/com-options.js',
    '/src/com-settings.js',
    '/src/updater/releases.js',
    '/src/updater/update-controller.js',
    '/src/remote-admin/actions.js',
    '/src/remote-admin/admin-auth.js',
    '/src/remote-admin/admin-certs.js',
    '/src/remote-admin/admin-config.js',
    '/src/remote-admin/admin-entry.js',
    '/src/remote-admin/admin-server.js',
    '/src/remote-admin/log-reader.js',
    '/src/remote-admin/net-guard.js',
    '/src/remote-admin/web/index.html',
    '/src/remote-admin/web/admin.js',
    '/src/remote-admin/web/admin.css',
    '/node_modules/electron-updater/package.json',
    '/node_modules/electron-updater/out/main.js'
  ];
  for (const file of required) check(files.has(file), `Missing from app.asar: ${file}`);
  check(![...files].some((f) => f.endsWith('.test.js')), 'app.asar contains test files');
}

if (problems.length > 0) {
  console.error(`Package verification FAILED (${problems.length} problem(s)) for version ${version}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Package verification passed for version ${version}: release assets, update metadata (SHA-512 matches), app-update.yml, updater and Remote Admin files are all present.`);

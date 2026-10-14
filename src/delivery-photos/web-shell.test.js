'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const { SHELL_FILES, shellVersion, serviceWorkerSource } = require('./web-shell');

const WEB_ROOT = nodePath.join(__dirname, '..', '..', 'delivery-photos-web');

test('every app shell file exists', () => {
  for (const [urlPath, filePath] of Object.entries(SHELL_FILES)) assert.ok(fs.existsSync(filePath), `${urlPath} -> ${filePath}`);
});

test('everything index.html loads is in the offline app shell (so it opens with no PC)', () => {
  const html = fs.readFileSync(nodePath.join(WEB_ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((ref) => !ref.startsWith('data:'));
  assert.ok(refs.length >= 8);
  for (const ref of refs) {
    const urlPath = ref.startsWith('/') ? ref : `/${ref}`;
    assert.ok(urlPath in SHELL_FILES, `${ref} is loaded by index.html but would not be available offline`);
  }
});

test('the Data Matrix decoder and its WebAssembly are part of the shell, and nothing loads from a CDN', () => {
  assert.ok('/vendor/zxing/zxing-reader.js' in SHELL_FILES);
  assert.ok('/vendor/zxing/zxing_reader.wasm' in SHELL_FILES);
  const html = fs.readFileSync(nodePath.join(WEB_ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /https?:\/\//, 'index.html must not load anything from another site');
  const scanner = fs.readFileSync(nodePath.join(WEB_ROOT, 'scanner.js'), 'utf8');
  assert.match(scanner, /locateFile: \(path\) => WASM_DIR \+ path/, 'the .wasm is always fetched from this site');
});

test('the served Service Worker carries the real file list and a content version, with no placeholders left', () => {
  const source = serviceWorkerSource();
  assert.doesNotMatch(source, /__SHELL_VERSION__|__SHELL_FILES__/);
  assert.match(source, new RegExp(`const VERSION = "${shellVersion()}";`));
  const list = JSON.parse(/const SHELL_FILES = (\[.*?\]);/.exec(source)[1]);
  assert.deepEqual(list, Object.keys(SHELL_FILES));
  assert.match(shellVersion(), /^[0-9a-f]{16}$/);
});

test('the Service Worker never handles the Photo Service API (uploads, pairing, completion)', () => {
  const source = fs.readFileSync(nodePath.join(WEB_ROOT, 'sw.js'), 'utf8');
  assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)[^\n]*return;/);
  assert.match(source, /if \(request\.method !== 'GET'\) return;/);
});

test('the manifest makes the tool installable on the Home Screen', () => {
  const manifest = JSON.parse(fs.readFileSync(nodePath.join(WEB_ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.ok(icon.src in SHELL_FILES, icon.src);
});

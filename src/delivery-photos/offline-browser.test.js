'use strict';

// The real iPad page in a real browser (headless Google Chrome, driven by
// playwright-core) against the real local HTTPS Photo Service: installs the
// offline app shell while "on the workshop Wi-Fi", then switches the PC off
// and proves the tool still opens, still decodes a Data Matrix code, and
// saves a delivery on the device - then switches the PC back on and proves
// the foreground sync files it on the (temp) drive and records it once.
//
// Chrome stands in for iPad Safari here: the Service Worker, Cache Storage,
// IndexedDB, camera (a fake device) and fetch/XHR APIs used are the same web
// standards. Skips cleanly if this machine has no Chrome installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const { X509Certificate, createHash } = require('node:crypto');

const { startServers } = require('./http-server');
const { ensureCertificates } = require('./certs');
const { runInWorker } = require('./worker-runner');
const { makeEnv, quietLogger } = require('./helpers');
const { PairingManager } = require('./auth');
const { ConcurrencyLimiter } = require('./concurrency');
const { listPendingEvents } = require('./tracking');
const { countOrdersFiledOn } = require('./filed-today');

const PORT = 9600;

async function launchChrome(spki) {
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    return null;
  }
  try {
    return await chromium.launch({
      channel: 'chrome',
      // Trust exactly this test certificate (as an iPad trusts the installed
      // profile) - a certificate error would stop the Service Worker.
      args: [`--ignore-certificate-errors-spki-list=${spki}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
    });
  } catch {
    return null;
  }
}

async function waitFor(fn, { timeoutMs = 30000, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function dataMatrixPng(text) {
  const { writeBarcode } = await import('zxing-wasm/writer');
  const result = await writeBarcode(text, { format: 'DataMatrix', scale: 8 });
  assert.equal(result.error, '');
  return Buffer.from(await result.image.arrayBuffer()).toString('base64');
}

async function captureDelivery(page, code, photos) {
  await page.click('#manual-entry-button');
  await page.fill('#manual-entry-input', code);
  await page.click('#manual-entry-form button[type=submit]');
  await page.waitForSelector('#capture-screen:not([hidden])');
  // As a person would: the shutter is pressed once the live picture is showing.
  await page.waitForFunction(() => document.getElementById('capture-video').videoWidth > 0);
  for (let i = 1; i <= photos; i++) {
    await page.click('#shutter-button');
    await page.waitForFunction((n) => document.querySelectorAll('#thumbnails .thumb').length === n, i);
  }
  await page.click('#done-button');
  await page.waitForSelector('#result-screen:not([hidden])', { timeout: 30000 });
  return page.textContent('#result-heading');
}

test('offline app shell, offline scanning, offline capture, and foreground sync - in a real browser', { timeout: 180000 }, async (t) => {
  const env = makeEnv();
  const credentials = ensureCertificates(nodePath.join(env.home, 'certs'), 'localhost');
  const spki = createHash('sha256').update(new X509Certificate(credentials.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const browser = await launchChrome(spki);
  if (!browser) {
    env.cleanup();
    t.skip('Google Chrome is not installed on this machine - the browser-level offline test needs it.');
    return;
  }

  const config = { hostname: 'localhost', port: PORT, photoRoot: env.share, maxPhotoBytes: 18 * 1000 * 1000, operationTimeoutSeconds: 20, minFreeGb: 0 };
  const pairing = new PairingManager({ devicesPath: nodePath.join(env.home, 'paired-devices.json') });
  const queueDir = nodePath.join(env.home, 'tracking-queue');
  const filedLogDir = nodePath.join(env.home, 'filed-sessions');
  let handle = null;
  const startService = async () => {
    handle = startServers({ config, credentials, runWorker: runInWorker, logger: quietLogger(), spoolDir: env.spool, pairing, limiter: new ConcurrencyLimiter(), queueDir, filedLogDir });
    await handle.listen();
  };
  const stopService = async () => {
    await handle.close();
    handle = null;
  };
  const origin = `https://localhost:${PORT}`;
  const files = (folder) => {
    try {
      return fs.readdirSync(nodePath.join(env.share, folder)).sort();
    } catch {
      return [];
    }
  };
  const queuedOnPage = (page) =>
    page.evaluate(async () => {
      const store = await DeliveryOfflineQueue.openStore({ indexedDB });
      const sessions = await store.listSessions();
      const result = [];
      for (const s of sessions) result.push({ ...s, photos: (await store.getPhotos(s.sessionId)).map((p) => ({ size: p.bytes ? p.bytes.byteLength : 0, uploaded: p.uploaded })) });
      store.close();
      return result;
    });

  try {
    await startService();
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));

    // ---- 1. First visit, on the workshop Wi-Fi: pair, and the shell is cached.
    await page.goto(`${origin}/`);
    await page.waitForSelector('#pairing-screen:not([hidden])');
    await page.fill('#pairing-code-input', pairing.generateCode().code);
    await page.click('#pairing-form button[type=submit]');
    await page.waitForSelector('#scan-screen:not([hidden])');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 30000 });
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names.find((n) => n.startsWith('delivery-photos-shell-')));
      return (await cache.keys()).map((r) => new URL(r.url).pathname).sort();
    });
    assert.ok(cached.includes('/vendor/zxing/zxing_reader.wasm'), 'the Data Matrix decoder is cached on the device');
    assert.ok(cached.includes('/') && cached.includes('/app.js') && cached.includes('/offline-queue.js') && cached.includes('/reference.js'));
    await page.waitForFunction(() => /connected/.test(document.querySelector('#scan-screen [data-conn-text]').textContent));

    // ---- 2. The existing online workflow, unchanged: filed and verified straight away.
    const onlineHeading = await captureDelivery(page, '5701-DELIV', 2);
    assert.equal(onlineHeading, 'Photographs filed successfully');
    assert.deepEqual(files('5701-DELIV'), ['photo-001.jpg', 'photo-002.jpg']);
    assert.equal(listPendingEvents(queueDir).length, 1);
    assert.deepEqual(await queuedOnPage(page), [], 'nothing left on the device after a verified online delivery');
    await page.click('#scan-next-button');
    await page.waitForSelector('#scan-screen:not([hidden])');

    // ---- 3. Away from the workshop: the PC is unreachable. The tool still opens.
    await stopService();
    await page.reload();
    await page.waitForSelector('#scan-screen:not([hidden])', { timeout: 30000 });
    assert.equal(await page.title(), 'Delivery Photos');
    await page.waitForFunction(() => /not reachable/.test(document.querySelector('#scan-screen [data-conn-text]').textContent), null, { timeout: 15000 });

    // ...and the Data Matrix decoder works from the cached copy, through scanner.js itself.
    const png = await dataMatrixPng('5698-P2-DELIV');
    const decoded = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const frame = document.createElement('canvas');
      frame.width = img.naturalWidth + 80;
      frame.height = img.naturalHeight + 80;
      const ctx = frame.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, frame.width, frame.height);
      ctx.drawImage(img, 40, 40);
      // scanFrame() reads a <video>'s frame size; give the canvas the same two properties.
      frame.videoWidth = frame.width;
      frame.videoHeight = frame.height;
      return DeliveryPhotoScanner.scanFrame(frame, document.createElement('canvas'));
    }, png);
    assert.equal(decoded, '5698-P2-DELIV');

    // ...if the browser reports too little room, the save is refused and the
    // photographs are kept open (never half-saved, never silently lost)...
    await page.evaluate(() => {
      navigator.storage.estimate = async () => ({ usage: 999.99e6, quota: 1000e6 });
    });
    const refused = await captureDelivery(page, '5698-P2-DELIV', 3);
    assert.equal(refused, 'Could not save these photographs');
    assert.match(await page.textContent('#result-detail'), /not enough storage space/);
    assert.equal(await page.textContent('#retry-button'), 'TRY AGAIN');
    assert.deepEqual(await queuedOnPage(page), []);

    // ...and once there is room, TRY AGAIN saves that same delivery on the
    // device - not reported as filed.
    await page.evaluate(() => {
      delete navigator.storage.estimate; // back to the browser's real answer
    });
    await page.click('#retry-button');
    await page.waitForFunction(() => document.getElementById('result-heading').textContent === 'Saved on this iPad', null, { timeout: 30000 });
    const offlineHeading = await page.textContent('#result-heading');
    assert.equal(offlineHeading, 'Saved on this iPad');
    assert.match(await page.textContent('#result-detail'), /Waiting to send to company drive/);
    let queued = await queuedOnPage(page);
    assert.equal(queued.length, 1);
    assert.deepEqual([queued[0].reference, queued[0].orderNumber, queued[0].deliveryType, queued[0].partNo, queued[0].photoCount], ['5698-P2-DELIV', '5698', 'Part Delivery', 2, 3]);
    assert.ok(queued[0].photos.every((p) => p.size > 1000 && !p.uploaded), 'every photo stored with its data');
    assert.deepEqual(files('5698-P2-DELIV'), []);
    assert.equal(listPendingEvents(queueDir).length, 1, 'no new tracking event');
    assert.equal(countOrdersFiledOn(filedLogDir), 1, 'Orders filed today ignores the iPad-only delivery');

    // ---- 4. Closed and reopened while still away: the queue is still there.
    await page.click('#scan-next-button');
    await page.reload();
    await page.waitForSelector('#scan-screen:not([hidden])', { timeout: 30000 });
    await page.waitForFunction(() => /1 delivery waiting to send/.test(document.querySelector('#scan-screen [data-pending-banner]').textContent));
    await page.evaluate(() => {
      navigator.storage.estimate = async () => ({ usage: 85e9, quota: 100e9 }); // 85% used, plenty still free
    });
    await page.click('#scan-screen [data-pending-banner]');
    await page.waitForSelector('#pending-screen:not([hidden])');
    assert.match(await page.textContent('#pending-list'), /5698-P2-DELIV/);
    assert.match(await page.textContent('#pending-list'), /3 photos/);
    assert.match(await page.textContent('#pending-list'), /Waiting for workshop network/);
    await page.waitForFunction(() => /nearly full \(85% used\)/.test(document.getElementById('storage-warning').textContent));
    assert.equal(await page.isVisible('#storage-warning'), true);
    // Headless Chrome refuses persistent storage, so the person is told so too.
    assert.match(await page.textContent('#storage-persistence'), /Protected from automatic clearing: no/);
    assert.match(await page.textContent('#storage-warning'), /iPad may remove it if storage space becomes low/);
    assert.equal(await page.textContent('#storage-usage'), '85.0 GB used · 15.0 GB available');
    await page.evaluate(() => {
      delete navigator.storage.estimate;
    });

    // ---- 5. Back on the workshop Wi-Fi: coming back to the foreground sends it.
    await startService();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => files('5698-P2-DELIV').length === 3, { message: 'the queued photos to reach the drive' });
    await waitFor(async () => (await queuedOnPage(page)).length === 0, { message: 'the local copy to be removed' });
    const events = listPendingEvents(queueDir);
    assert.equal(events.length, 2);
    const event = events.find((e) => e.reference === '5698-P2-DELIV');
    assert.equal(event.eventId, queued[0].sessionId, 'the tracking Event ID is the iPad session id');
    assert.equal(countOrdersFiledOn(filedLogDir), 2);
    await page.waitForFunction(() => /Nothing waiting/.test(document.querySelector('#pending-summary').textContent));

    // ---- 6. Nothing was ever fetched from anywhere but the PC itself (no CDN).
    // (blob: and data: URLs are in-page thumbnails and test images - never a network request.)
    for (const url of requests) assert.ok(url.startsWith(`${origin}/`) || url.startsWith(`blob:${origin}/`) || url.startsWith('data:'), `unexpected request to ${url}`);

    await context.close();
  } finally {
    await browser.close();
    if (handle) await stopService();
    env.cleanup();
  }
});

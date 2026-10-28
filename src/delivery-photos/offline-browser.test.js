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
const https = require('node:https');
const nodePath = require('node:path');
const { X509Certificate, createHash } = require('node:crypto');

const { startServers } = require('./http-server');
const { ensureCertificates } = require('./certs');
const { runInWorker } = require('./worker-runner');
const { makeEnv } = require('./helpers');
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

// `diagnose` (optional) is called once on a timeout, and whatever it returns
// is put in the failure message - so a failure on a CI machine nobody can
// watch still says WHY, not just that it timed out.
async function waitFor(fn, { timeoutMs = 30000, message = 'condition', diagnose } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      let detail = '';
      if (diagnose) {
        try {
          detail = `\n${await diagnose()}`;
        } catch (err) {
          detail = `\n(diagnostics themselves failed: ${err && err.stack})`;
        }
      }
      throw new Error(`Timed out waiting for ${message}${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// ---- Diagnostics for the end-to-end steps ------------------------------------

const stamp = () => new Date().toISOString().slice(11, 23);

// The server's own log, kept (with times) instead of discarded: it records
// every upload accepted or refused and why, every archive success ("Filed
// ...") or failure ("Could not file ..."), and every session-complete report.
function recordingLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${stamp()} ${level} ${message}`);
  return { info: push('INFO'), warn: push('WARN'), error: push('ERROR'), lines };
}

// Every Photo Service request the page makes - sent, answered (with status)
// or failed (with the browser's reason) - plus page errors and warnings.
function watchPage(page, name, log) {
  const apiPath = (request) => {
    const url = new URL(request.url());
    return url.pathname.startsWith('/api/') ? url.pathname : null;
  };
  page.on('request', (r) => {
    const path = apiPath(r);
    if (path) log.push(`${stamp()} [${name}] -> ${r.method()} ${path}`);
  });
  page.on('requestfinished', async (r) => {
    const path = apiPath(r);
    if (!path) return;
    const response = await r.response().catch(() => null);
    log.push(`${stamp()} [${name}] <- ${response ? response.status() : 'no response'} ${r.method()} ${path}`);
  });
  page.on('requestfailed', (r) => {
    const path = apiPath(r);
    if (path) log.push(`${stamp()} [${name}] xx FAILED ${r.method()} ${path}: ${r.failure() && r.failure().errorText}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log.push(`${stamp()} [${name}] console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (err) => log.push(`${stamp()} [${name}] page error: ${err.message}`));
}

// What one iPad page believes: which screen, visible/focused or not, its
// connection strip, its pending list, and every queued session in its
// IndexedDB with each photo's sent/not-sent state. The pairing token itself
// is checked against the PC's pairing records here and never printed.
async function pageState(page, pairing) {
  const s = await page.evaluate(async () => {
    const visibleScreen = [...document.querySelectorAll('section.screen')].find((el) => !el.hidden);
    const out = {
      url: location.href,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      screen: visibleScreen ? visibleScreen.id : '(none)',
      connection: visibleScreen && visibleScreen.querySelector('[data-conn-text]') ? visibleScreen.querySelector('[data-conn-text]').textContent : '(no strip on this screen)',
      pendingSummary: document.getElementById('pending-summary').textContent,
      serviceWorkerControlling: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
      storedRole: localStorage.getItem('deliveryPhotosRole'),
      token: localStorage.getItem('deliveryPhotosToken') || '',
      queued: []
    };
    try {
      const store = await DeliveryOfflineQueue.openStore({ indexedDB });
      for (const q of await store.listSessions()) {
        const photos = await store.getPhotos(q.sessionId);
        out.queued.push({
          role: q.role,
          code: q.code,
          baseOrder: q.baseOrder,
          status: q.status,
          attempts: q.attempts,
          lastAttemptAt: q.lastAttemptAt,
          lastError: q.lastError,
          photos: photos.map((p) => (p.uploaded ? 'sent' : `waiting(${p.bytes ? p.bytes.byteLength : 0} bytes)`)).join(', ')
        });
      }
      store.close();
    } catch (err) {
      out.queued = `could not read the offline queue: ${err.message}`;
    }
    return out;
  });
  const auth = s.token ? pairing.verify(s.token) : { ok: false };
  delete s.token;
  s.pairing = auth.ok ? `valid (paired as ${auth.role})` : 'NOT valid on the PC (no token, or unknown/revoked)';
  return s;
}

// Asks the Photo Service directly (from the test, not the page) whether it answers.
function serviceAnswers(origin, caCert) {
  return new Promise((resolve) => {
    const req = https.get(`${origin}/api/health`, { ca: caCert, timeout: 3000 }, (res) => {
      res.resume();
      resolve(`answers (HTTP ${res.statusCode})`);
    });
    req.on('timeout', () => req.destroy(new Error('no answer within 3s')));
    req.on('error', (err) => resolve(`DOES NOT answer: ${err.message}`));
  });
}

function folderState(share, folders) {
  const lines = [];
  try {
    lines.push(`drive root: ${JSON.stringify(fs.readdirSync(share).sort())}`);
  } catch (err) {
    lines.push(`drive root unreadable: ${err.message}`);
  }
  for (const folder of folders) {
    try {
      lines.push(`${folder}: ${JSON.stringify(fs.readdirSync(nodePath.join(share, folder)).sort())}`);
    } catch (err) {
      lines.push(`${folder}: ${err.code === 'ENOENT' ? 'folder does not exist' : err.message}`);
    }
  }
  return lines.join('\n  ');
}

// Everything above in one report, for a waitFor() timeout.
function diagnostics({ pages, pairing, origin, caCert, share, folders, logger, browserLog }) {
  return async () => {
    const parts = [`--- diagnostics at ${stamp()} ---`, `Photo Service, asked directly: ${await serviceAnswers(origin, caCert)}`, `Company drive (test folder):\n  ${folderState(share, folders)}`];
    for (const [name, page] of Object.entries(pages)) {
      try {
        parts.push(`iPad "${name}": ${JSON.stringify(await pageState(page, pairing), null, 2)}`);
      } catch (err) {
        parts.push(`iPad "${name}": could not read its state: ${err.message}`);
      }
    }
    parts.push(`Requests the iPads made to the Photo Service (-> sent, <- answered, xx failed):\n  ${browserLog.join('\n  ') || '(none)'}`);
    parts.push(`Photo Service log (uploads accepted/refused, archive results, session-complete reports):\n  ${logger.lines.join('\n  ') || '(empty)'}`);
    return parts.join('\n');
  };
}

async function dataMatrixPng(text) {
  const { writeBarcode } = await import('zxing-wasm/writer');
  const result = await writeBarcode(text, { format: 'DataMatrix', scale: 8 });
  assert.equal(result.error, '');
  return Buffer.from(await result.image.arrayBuffer()).toString('base64');
}

// Waits until the camera preview has shown a NEW frame since the last call,
// as a person pressing the shutter repeatedly would see the picture move.
// Without this, two quick presses can capture the very same video frame -
// byte-identical JPEGs, which the PC (correctly) treats as one photograph
// sent twice and files once. Chrome's fake camera on a slow Windows CI
// runner did exactly that. Fails with a clear message if the camera has
// stopped producing frames at all.
async function nextCameraFrame(page) {
  const ok = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const video = document.getElementById('capture-video');
        const timer = setTimeout(() => resolve(false), 15000);
        video.requestVideoFrameCallback(() => {
          clearTimeout(timer);
          resolve(true);
        });
      })
  );
  assert.ok(ok, 'the camera preview produced no new frame within 15 seconds');
}

async function pressShutter(page, alreadyTaken) {
  await nextCameraFrame(page);
  await page.click('#shutter-button');
  await page.waitForFunction((n) => document.querySelectorAll('#thumbnails .thumb').length === n, alreadyTaken + 1);
}

// Every photo queued in one session on the page must be a different image -
// otherwise the drive would (rightly) end up with fewer files than photos,
// and a later "files on the drive" wait would fail for a reason that has
// nothing to do with sending.
async function assertQueuedPhotosDistinct(page) {
  const sessions = await page.evaluate(async () => {
    const store = await DeliveryOfflineQueue.openStore({ indexedDB });
    const out = [];
    for (const q of await store.listSessions()) out.push({ code: q.code, hashes: (await store.getPhotos(q.sessionId)).map((p) => p.sha256) });
    store.close();
    return out;
  });
  for (const q of sessions) assert.equal(new Set(q.hashes).size, q.hashes.length, `the queued ${q.code} photos are not all different images: ${q.hashes.join(', ')}`);
}

async function captureDelivery(page, code, photos) {
  await page.click('#manual-entry-button');
  await page.fill('#manual-entry-input', code);
  await page.click('#manual-entry-form button[type=submit]');
  await page.waitForSelector('#capture-screen:not([hidden])');
  // As a person would: the shutter is pressed once the live picture is showing.
  await page.waitForFunction(() => document.getElementById('capture-video').videoWidth > 0);
  for (let i = 0; i < photos; i++) await pressShutter(page, i);
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
  const logger = recordingLogger();
  const browserLog = [];
  let handle = null;
  const startService = async () => {
    handle = startServers({ config, credentials, runWorker: runInWorker, logger, spoolDir: env.spool, pairing, limiter: new ConcurrencyLimiter(), queueDir, filedLogDir });
    await handle.listen();
  };
  // The PC switched off: no new connections AND none of the browser's
  // already-open keep-alive connections answer any more. (server.close()
  // alone keeps serving those until they go idle - about 25 seconds with
  // the page checking in every 20 - so "offline" would not really be
  // offline yet.)
  const stopService = async () => {
    const closing = handle.close();
    handle.httpsServer.closeAllConnections();
    handle.httpServer.closeAllConnections();
    await closing;
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
    watchPage(page, 'delivery', browserLog);
    const diagnose = diagnostics({ pages: { delivery: page }, pairing, origin, caCert: credentials.caCert, share: env.share, folders: ['5701', '5698'], logger, browserLog });
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));

    // ---- 1. First visit, on the workshop Wi-Fi: pair, and the shell is cached.
    await page.goto(`${origin}/`);
    await page.waitForSelector('#pairing-screen:not([hidden])');
    await page.fill('#pairing-code-input', pairing.generateCode({ role: 'delivery' }).code);
    await page.click('#pairing-form button[type=submit]');
    await page.waitForSelector('#scan-screen:not([hidden])');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 30000 });
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names.find((n) => n.startsWith('delivery-photos-shell-')));
      return (await cache.keys()).map((r) => new URL(r.url).pathname).sort();
    });
    assert.ok(cached.includes('/vendor/zxing/zxing_reader.wasm'), 'the Data Matrix decoder is cached on the device');
    assert.ok(cached.includes('/') && cached.includes('/app.js') && cached.includes('/offline-queue.js') && cached.includes('/reference.js') && cached.includes('/photo-roles.js'));
    assert.equal(await page.textContent('#scan-screen [data-role-heading]'), 'DELIVERY PHOTOS');
    await page.waitForFunction(() => /connected/.test(document.querySelector('#scan-screen [data-conn-text]').textContent));

    // ---- 2. The existing online workflow, unchanged: filed and verified straight away.
    const onlineHeading = await captureDelivery(page, '5701-DELIV', 2);
    assert.equal(onlineHeading, 'Photographs filed successfully');
    assert.deepEqual(files('5701'), ['001-DELIV.jpg', '002-DELIV.jpg']);
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
    await assertQueuedPhotosDistinct(page);
    let queued = await queuedOnPage(page);
    assert.equal(queued.length, 1);
    assert.deepEqual([queued[0].role, queued[0].code, queued[0].baseOrder, queued[0].reference, queued[0].orderNumber, queued[0].deliveryType, queued[0].partNo, queued[0].photoCount], ['delivery', '5698-P2-DELIV', '5698', '5698-P2-DELIV', '5698', 'Part Delivery', 2, 3]);
    assert.ok(queued[0].photos.every((p) => p.size > 1000 && !p.uploaded), 'every photo stored with its data');
    assert.deepEqual(files('5698'), []);
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
    await waitFor(() => files('5698').length === 3, { message: 'the queued photos to reach the drive', diagnose });
    assert.deepEqual(files('5698'), ['001-DELIV.jpg', '002-DELIV.jpg', '003-DELIV.jpg']);
    await waitFor(async () => (await queuedOnPage(page)).length === 0, { message: 'the local copy to be removed', diagnose });
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

test('Bench and Ironmongery iPads in a real browser: role shown, codes checked, photos named by the PC, offline queue', { timeout: 180000 }, async (t) => {
  const env = makeEnv();
  const credentials = ensureCertificates(nodePath.join(env.home, 'certs'), 'localhost');
  const spki = createHash('sha256').update(new X509Certificate(credentials.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const browser = await launchChrome(spki);
  if (!browser) {
    env.cleanup();
    t.skip('Google Chrome is not installed on this machine - the browser-level offline test needs it.');
    return;
  }

  const port = PORT + 2;
  const config = { hostname: 'localhost', port, photoRoot: env.share, maxPhotoBytes: 18 * 1000 * 1000, operationTimeoutSeconds: 20, minFreeGb: 0 };
  const pairing = new PairingManager({ devicesPath: nodePath.join(env.home, 'paired-devices.json') });
  const queueDir = nodePath.join(env.home, 'tracking-queue');
  const filedLogDir = nodePath.join(env.home, 'filed-sessions');
  const logger = recordingLogger();
  const browserLog = [];
  let handle = null;
  const startService = async () => {
    handle = startServers({ config, credentials, runWorker: runInWorker, logger, spoolDir: env.spool, pairing, limiter: new ConcurrencyLimiter(), queueDir, filedLogDir });
    await handle.listen();
  };
  // The PC switched off: no new connections AND none of the browser's
  // already-open keep-alive connections answer any more. (server.close()
  // alone keeps serving those until they go idle - about 25 seconds with
  // the page checking in every 20 - so "offline" would not really be
  // offline yet.)
  const stopService = async () => {
    const closing = handle.close();
    handle.httpsServer.closeAllConnections();
    handle.httpServer.closeAllConnections();
    await closing;
    handle = null;
  };
  const origin = `https://localhost:${port}`;
  const files = (folder) => {
    try {
      return fs.readdirSync(nodePath.join(env.share, folder)).sort();
    } catch {
      return [];
    }
  };

  async function pairedPage(role) {
    const context = await browser.newContext();
    const page = await context.newPage();
    watchPage(page, role, browserLog);
    await page.goto(`${origin}/`);
    await page.waitForSelector('#pairing-screen:not([hidden])');
    assert.equal(await page.isVisible('#pairing-skip-button'), false, 'a never-paired iPad has no role to take photos as yet');
    await page.fill('#pairing-code-input', pairing.generateCode({ role }).code);
    await page.click('#pairing-form button[type=submit]');
    await page.waitForSelector('#scan-screen:not([hidden])');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 30000 });
    return { context, page };
  }

  async function capture(page, code, photos) {
    if (await page.isHidden('#manual-entry-form')) await page.click('#manual-entry-button');
    await page.fill('#manual-entry-input', code);
    await page.click('#manual-entry-form button[type=submit]');
    await page.waitForSelector('#capture-screen:not([hidden])');
    const header = { role: await page.textContent('#capture-role'), label: await page.textContent('#reference-label'), sub: await page.textContent('#reference-sub') };
    await page.waitForFunction(() => document.getElementById('capture-video').videoWidth > 0);
    for (let i = 0; i < photos; i++) await pressShutter(page, i);
    await page.click('#done-button');
    await page.waitForSelector('#result-screen:not([hidden])', { timeout: 30000 });
    return { heading: await page.textContent('#result-heading'), header };
  }

  try {
    await startService();
    fs.mkdirSync(nodePath.join(env.share, '5698'));
    fs.writeFileSync(nodePath.join(env.share, '5698', '001-DELIV.jpg'), 'earlier delivery photo');

    // ---- Bench: the role is obvious, a delivery code is refused, a door label files as -BENCH.
    const bench = await pairedPage('bench');
    assert.equal(await bench.page.textContent('#scan-screen [data-role-heading]'), 'BENCH PHOTOS');
    assert.equal(await bench.page.title(), 'Bench Photos');
    assert.match(await bench.page.textContent('#scan-message'), /Scan a door or frame label/);
    await bench.page.click('#manual-entry-button');
    await bench.page.fill('#manual-entry-input', '5698-DELIV');
    await bench.page.click('#manual-entry-form button[type=submit]');
    assert.equal(await bench.page.isVisible('#scan-screen'), true, 'a delivery code is not accepted on a Bench iPad');
    assert.match(await bench.page.evaluate(() => document.getElementById('manual-entry-input').validationMessage), /door or frame label/);

    const online = await capture(bench.page, '5698-D-07', 2);
    assert.equal(online.heading, 'Photographs filed successfully');
    assert.deepEqual(online.header, { role: 'BENCH PHOTOS', label: 'Scanned: 5698-D-07', sub: 'Order: 5698 · Photos will save under order 5698' });
    assert.deepEqual(files('5698'), ['001-DELIV.jpg', '002-BENCH.jpg', '003-BENCH.jpg']);
    assert.deepEqual(listPendingEvents(queueDir), [], 'no Delivery Sheet event for Bench photos');
    await bench.page.click('#scan-next-button');

    // ---- Ironmongery: the order-number box is open straight away; "5626-2" files as -IRN.
    const irn = await pairedPage('ironmongery');
    assert.equal(await irn.page.textContent('#scan-screen [data-role-heading]'), 'IRONMONGERY PHOTOS');
    assert.equal(await irn.page.isVisible('#manual-entry-form'), true);
    assert.equal(await irn.page.textContent('#manual-entry-label'), 'Order number');
    const irnOnline = await capture(irn.page, '5626-2', 1);
    assert.deepEqual(irnOnline.header, { role: 'IRONMONGERY PHOTOS', label: 'Order: 5626-2', sub: 'Photos will save under order 5626-2' });
    assert.deepEqual(files('5626-2'), ['001-IRN.jpg']);
    await irn.page.click('#scan-next-button');

    // ---- Offline: both iPads save on the device; the pending list shows role, order and count.
    await stopService();
    for (const p of [bench.page, irn.page]) {
      await p.reload();
      await p.waitForSelector('#scan-screen:not([hidden])', { timeout: 30000 });
    }
    assert.equal(await bench.page.textContent('#scan-screen [data-role-heading]'), 'BENCH PHOTOS', 'the role is remembered away from the workshop');
    assert.equal((await capture(bench.page, '5698-F-02', 4)).heading, 'Saved on this iPad');
    assert.equal((await capture(irn.page, '5626-2', 3)).heading, 'Saved on this iPad');
    await assertQueuedPhotosDistinct(bench.page);
    await assertQueuedPhotosDistinct(irn.page);

    await bench.page.click('#scan-next-button');
    await bench.page.click('#scan-screen [data-pending-banner]');
    await bench.page.waitForSelector('#pending-screen:not([hidden])');
    const benchPending = await bench.page.textContent('#pending-list');
    assert.match(benchPending, /Bench/);
    assert.match(benchPending, /5698/);
    assert.match(benchPending, /4 photos/);
    assert.match(benchPending, /Waiting for workshop network/);
    await irn.page.click('#scan-next-button');
    await irn.page.click('#scan-screen [data-pending-banner]');
    await irn.page.waitForSelector('#pending-screen:not([hidden])');
    const irnPending = await irn.page.textContent('#pending-list');
    assert.match(irnPending, /Ironmongery/);
    assert.match(irnPending, /5626-2/);
    assert.match(irnPending, /3 photos/);

    // ---- Back on the workshop Wi-Fi: each sends, under the role the PC holds for it.
    await startService();
    for (const p of [bench.page, irn.page]) await p.evaluate(() => window.dispatchEvent(new Event('focus')));
    const diagnose = diagnostics({ pages: { bench: bench.page, ironmongery: irn.page }, pairing, origin, caCert: credentials.caCert, share: env.share, folders: ['5698', '5626-2'], logger, browserLog });
    // Each iPad separately, so a failure says which one did not send.
    await waitFor(() => files('5698').length >= 7, { message: 'the Bench iPad\'s queued photos to reach folder 5698', diagnose });
    await waitFor(() => files('5626-2').length >= 4, { message: 'the Ironmongery iPad\'s queued photos to reach folder 5626-2', diagnose });
    assert.deepEqual(files('5698'), ['001-DELIV.jpg', '002-BENCH.jpg', '003-BENCH.jpg', '004-BENCH.jpg', '005-BENCH.jpg', '006-BENCH.jpg', '007-BENCH.jpg']);
    assert.deepEqual(files('5626-2'), ['001-IRN.jpg', '002-IRN.jpg', '003-IRN.jpg', '004-IRN.jpg']);
    for (const p of [bench.page, irn.page]) await p.waitForFunction(() => /Nothing waiting/.test(document.querySelector('#pending-summary').textContent), null, { timeout: 30000 });
    assert.deepEqual(listPendingEvents(queueDir), []);
    assert.equal(countOrdersFiledOn(filedLogDir), 0);

    await bench.context.close();
    await irn.context.close();
  } finally {
    await browser.close();
    if (handle) await stopService();
    env.cleanup();
  }
});

// ---- Scanning through the camera: Data Matrix and QR Code -------------------

async function codePng(format, text) {
  const { writeBarcode } = await import('zxing-wasm/writer');
  const result = await writeBarcode(text, { format, scale: 8 });
  assert.equal(result.error, '');
  return Buffer.from(await result.image.arrayBuffer()).toString('base64');
}

// Replaces the iPad's camera with a canvas the test can hold a code up to:
// getUserMedia() returns the canvas's own video stream, so the real scanning
// loop (scanner.js), the real decoder and the real role check all run on
// what it shows. A frame counter is drawn in a corner so every photograph
// taken from it is a different image.
function fakeCameraScript() {
  let canvas = null;
  let code = null;
  let frame = 0;
  function draw() {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#9aa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (code) {
      const x = (canvas.width - code.naturalWidth) / 2;
      const y = (canvas.height - code.naturalHeight) / 2;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 40, y - 40, code.naturalWidth + 80, code.naturalHeight + 80);
      ctx.drawImage(code, x, y);
    }
    ctx.fillStyle = '#000';
    ctx.font = '24px sans-serif';
    ctx.fillText(`frame ${++frame}`, 20, 40);
  }
  window.__fakeCamera = {
    async show(b64) {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      code = img;
    },
    clear() {
      code = null;
    }
  };
  navigator.mediaDevices.getUserMedia = async () => {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      draw();
      setInterval(draw, 50);
    }
    return canvas.captureStream(30);
  };
}

test('QR Codes and Data Matrix codes scanned through the camera behave identically, online and offline - in a real browser', { timeout: 240000 }, async (t) => {
  const env = makeEnv();
  const credentials = ensureCertificates(nodePath.join(env.home, 'certs'), 'localhost');
  const spki = createHash('sha256').update(new X509Certificate(credentials.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const browser = await launchChrome(spki);
  if (!browser) {
    env.cleanup();
    t.skip('Google Chrome is not installed on this machine - the browser-level offline test needs it.');
    return;
  }

  const port = PORT + 4;
  const config = { hostname: 'localhost', port, photoRoot: env.share, maxPhotoBytes: 18 * 1000 * 1000, operationTimeoutSeconds: 20, minFreeGb: 0 };
  const pairing = new PairingManager({ devicesPath: nodePath.join(env.home, 'paired-devices.json') });
  const queueDir = nodePath.join(env.home, 'tracking-queue');
  const filedLogDir = nodePath.join(env.home, 'filed-sessions');
  const logger = recordingLogger();
  const browserLog = [];
  let handle = null;
  const startService = async () => {
    handle = startServers({ config, credentials, runWorker: runInWorker, logger, spoolDir: env.spool, pairing, limiter: new ConcurrencyLimiter(), queueDir, filedLogDir });
    await handle.listen();
  };
  // The PC switched off, open keep-alive connections included (see above).
  const stopService = async () => {
    const closing = handle.close();
    handle.httpsServer.closeAllConnections();
    handle.httpServer.closeAllConnections();
    await closing;
    handle = null;
  };
  const origin = `https://localhost:${port}`;
  const files = (folder) => {
    try {
      return fs.readdirSync(nodePath.join(env.share, folder)).sort();
    } catch {
      return [];
    }
  };
  const requests = [];

  async function pairedPage(role) {
    const context = await browser.newContext();
    await context.addInitScript(fakeCameraScript);
    const page = await context.newPage();
    watchPage(page, role, browserLog);
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(`${origin}/`);
    await page.waitForSelector('#pairing-screen:not([hidden])');
    await page.fill('#pairing-code-input', pairing.generateCode({ role }).code);
    await page.click('#pairing-form button[type=submit]');
    await page.waitForSelector('#scan-screen:not([hidden])');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 30000 });
    return { context, page };
  }

  // Holds a code up to the camera and waits for the scanner to refuse it,
  // with the same message the role check gives for it. Never reaches the
  // capture screen.
  async function scanRefused(page, format, text, label) {
    await page.evaluate(() => {
      document.getElementById('scan-message').textContent = '';
    });
    await page.evaluate((b64) => window.__fakeCamera.show(b64), await codePng(format, text));
    await page.waitForFunction((l) => document.getElementById('scan-message').textContent.startsWith(`That is not a ${l} code`), label, { timeout: 20000 });
    await page.evaluate(() => window.__fakeCamera.clear());
    assert.equal(await page.isVisible('#scan-screen'), true, `${format} "${text}" is not accepted on a ${label} iPad`);
    assert.equal(await page.isVisible('#capture-screen'), false);
  }

  // Holds a code up to the camera; once the scanner has accepted it, takes
  // `photos` photographs and finishes - back on the scan screen afterwards.
  async function scanAndCapture(page, format, text, photos) {
    assert.equal(await page.isVisible('#scan-screen'), true);
    await page.evaluate((b64) => window.__fakeCamera.show(b64), await codePng(format, text));
    await page.waitForSelector('#capture-screen:not([hidden])', { timeout: 20000 });
    await page.evaluate(() => window.__fakeCamera.clear());
    const header = { role: await page.textContent('#capture-role'), label: await page.textContent('#reference-label'), sub: await page.textContent('#reference-sub') };
    await page.waitForFunction(() => document.getElementById('capture-video').videoWidth > 0);
    for (let i = 0; i < photos; i++) await pressShutter(page, i);
    await page.click('#done-button');
    await page.waitForSelector('#result-screen:not([hidden])', { timeout: 30000 });
    const heading = await page.textContent('#result-heading');
    await page.click('#scan-next-button');
    await page.waitForSelector('#scan-screen:not([hidden])');
    return { heading, header };
  }

  const queuedCodes = (page) =>
    page.evaluate(async () => {
      const store = await DeliveryOfflineQueue.openStore({ indexedDB });
      const out = (await store.listSessions()).map((s) => `${s.role} ${s.code} -> ${s.baseOrder} (${s.photoCount})`).sort();
      store.close();
      return out;
    });
  // A tracking event, minus what is different for every event anyway.
  const eventContent = (e) => ({ orderNumber: e.orderNumber, reference: e.reference, deliveryType: e.deliveryType, partNo: e.partNo, photosSaved: e.photosSaved });

  try {
    await startService();
    const delivery = await pairedPage('delivery');
    const bench = await pairedPage('bench');
    const irn = await pairedPage('ironmongery');
    const pages = { delivery: delivery.page, bench: bench.page, ironmongery: irn.page };
    const diagnose = diagnostics({ pages, pairing, origin, caCert: credentials.caCert, share: env.share, folders: ['5698', '5626-2'], logger, browserLog });

    // ---- Delivery: nonsense and another role's code are refused; DM and QR file the same.
    await scanRefused(delivery.page, 'QRCode', 'HELLO', 'Delivery');
    await scanRefused(delivery.page, 'QRCode', '5698-D-01', 'Delivery');
    const dmDeliv = await scanAndCapture(delivery.page, 'DataMatrix', '5698-DELIV', 1);
    const qrDeliv = await scanAndCapture(delivery.page, 'QRCode', '5698-DELIV', 1);
    assert.equal(dmDeliv.heading, 'Photographs filed successfully');
    assert.deepEqual(qrDeliv, dmDeliv, 'a QR Code and a Data Matrix with the same text give the same capture screen and result');
    const qrPart = await scanAndCapture(delivery.page, 'QRCode', '5698-P2-DELIV', 1);
    assert.equal(qrPart.heading, 'Photographs filed successfully');
    assert.deepEqual(files('5698'), ['001-DELIV.jpg', '002-DELIV.jpg', '003-DELIV.jpg']);
    const onlineEvents = listPendingEvents(queueDir).map(eventContent);
    assert.equal(onlineEvents.length, 3);
    assert.deepEqual(onlineEvents.filter((e) => e.reference === '5698-DELIV'), [eventContent({ orderNumber: '5698', reference: '5698-DELIV', deliveryType: 'Full Delivery', partNo: '', photosSaved: 1 }), eventContent({ orderNumber: '5698', reference: '5698-DELIV', deliveryType: 'Full Delivery', partNo: '', photosSaved: 1 })], 'the same tracking record from a QR Code as from a Data Matrix');
    assert.deepEqual(onlineEvents.find((e) => e.reference === '5698-P2-DELIV'), { orderNumber: '5698', reference: '5698-P2-DELIV', deliveryType: 'Part Delivery', partNo: 2, photosSaved: 1 });

    // ---- Bench: a delivery code in a QR Code is refused; door/frame labels in either format file as -BENCH.
    await scanRefused(bench.page, 'QRCode', '5698-DELIV', 'Bench');
    await scanRefused(bench.page, 'DataMatrix', '5698', 'Bench');
    const dmDoor = await scanAndCapture(bench.page, 'DataMatrix', '5698-D-01', 1);
    const qrDoor = await scanAndCapture(bench.page, 'QRCode', '5698-D-01', 1);
    assert.deepEqual(dmDoor, { heading: 'Photographs filed successfully', header: { role: 'BENCH PHOTOS', label: 'Scanned: 5698-D-01', sub: 'Order: 5698 · Photos will save under order 5698' } });
    assert.deepEqual(qrDoor, dmDoor);
    const qrFrame = await scanAndCapture(bench.page, 'QRCode', '5626-2-F-03', 1);
    assert.deepEqual(qrFrame.header, { role: 'BENCH PHOTOS', label: 'Scanned: 5626-2-F-03', sub: 'Order: 5626-2 · Photos will save under order 5626-2' });

    // ---- Ironmongery: an order number in either format files as -IRN.
    await scanRefused(irn.page, 'QRCode', '5626-2-F-03', 'Ironmongery');
    const dmOrder = await scanAndCapture(irn.page, 'DataMatrix', '5698', 1);
    const qrOrder = await scanAndCapture(irn.page, 'QRCode', '5698', 1);
    assert.deepEqual(dmOrder, { heading: 'Photographs filed successfully', header: { role: 'IRONMONGERY PHOTOS', label: 'Order: 5698', sub: 'Photos will save under order 5698' } });
    assert.deepEqual(qrOrder, dmOrder);
    const qrSubOrder = await scanAndCapture(irn.page, 'QRCode', '5626-2', 1);
    assert.deepEqual(qrSubOrder.header, { role: 'IRONMONGERY PHOTOS', label: 'Order: 5626-2', sub: 'Photos will save under order 5626-2' });

    assert.deepEqual(files('5698'), ['001-DELIV.jpg', '002-DELIV.jpg', '003-DELIV.jpg', '004-BENCH.jpg', '005-BENCH.jpg', '006-IRN.jpg', '007-IRN.jpg']);
    assert.deepEqual(files('5626-2'), ['001-BENCH.jpg', '002-IRN.jpg']);
    assert.equal(listPendingEvents(queueDir).length, 3, 'only Delivery photos make tracking events');

    // ---- Offline: the PC is unreachable. Each iPad reopens from its cached
    // shell and still decodes both formats from the cached decoder.
    await stopService();
    for (const p of Object.values(pages)) {
      await p.reload();
      await p.waitForSelector('#scan-screen:not([hidden])', { timeout: 30000 });
    }
    await scanRefused(bench.page, 'QRCode', '5626-2-P3-DELIV', 'Bench');
    assert.equal((await scanAndCapture(delivery.page, 'QRCode', '5626-2-P3-DELIV', 2)).heading, 'Saved on this iPad');
    assert.equal((await scanAndCapture(delivery.page, 'DataMatrix', '5698-P-DELIV', 1)).heading, 'Saved on this iPad');
    assert.equal((await scanAndCapture(bench.page, 'DataMatrix', '5698-F-07', 1)).heading, 'Saved on this iPad');
    assert.equal((await scanAndCapture(bench.page, 'QRCode', '5626-2-D-01', 2)).heading, 'Saved on this iPad');
    assert.equal((await scanAndCapture(irn.page, 'QRCode', '5626-2', 1)).heading, 'Saved on this iPad');
    assert.equal((await scanAndCapture(irn.page, 'DataMatrix', '5698', 1)).heading, 'Saved on this iPad');
    assert.deepEqual(await queuedCodes(delivery.page), ['delivery 5626-2-P3-DELIV -> 5626-2 (2)', 'delivery 5698-P-DELIV -> 5698 (1)']);
    assert.deepEqual(await queuedCodes(bench.page), ['bench 5626-2-D-01 -> 5626-2 (2)', 'bench 5698-F-07 -> 5698 (1)']);
    assert.deepEqual(await queuedCodes(irn.page), ['ironmongery 5626-2 -> 5626-2 (1)', 'ironmongery 5698 -> 5698 (1)']);
    for (const p of Object.values(pages)) await assertQueuedPhotosDistinct(p);

    // ---- Back on the workshop Wi-Fi: everything sends, named by role as usual.
    await startService();
    for (const p of Object.values(pages)) await p.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => files('5698').length === 10 && files('5626-2').length === 7, { message: 'every queued photo to reach the drive', diagnose });
    const suffixes = (folder) => files(folder).map((f) => f.replace(/^\d{3}-/, '')).sort();
    assert.deepEqual(suffixes('5698'), ['BENCH.jpg', 'BENCH.jpg', 'BENCH.jpg', 'DELIV.jpg', 'DELIV.jpg', 'DELIV.jpg', 'DELIV.jpg', 'IRN.jpg', 'IRN.jpg', 'IRN.jpg']);
    assert.deepEqual(suffixes('5626-2'), ['BENCH.jpg', 'BENCH.jpg', 'BENCH.jpg', 'DELIV.jpg', 'DELIV.jpg', 'IRN.jpg', 'IRN.jpg']);
    assert.deepEqual(files('5698').map((f) => f.slice(0, 3)), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010'], 'numbering carries on with no gaps');
    for (const p of Object.values(pages)) await p.waitForFunction(() => /Nothing waiting/.test(document.querySelector('#pending-summary').textContent), null, { timeout: 30000 });
    const allEvents = listPendingEvents(queueDir).map(eventContent);
    assert.equal(allEvents.length, 5);
    assert.deepEqual(allEvents.find((e) => e.reference === '5626-2-P3-DELIV'), { orderNumber: '5626-2', reference: '5626-2-P3-DELIV', deliveryType: 'Part Delivery', partNo: 3, photosSaved: 2 });
    assert.deepEqual(allEvents.find((e) => e.reference === '5698-P-DELIV'), { orderNumber: '5698', reference: '5698-P-DELIV', deliveryType: 'Part Delivery', partNo: 1, photosSaved: 1 });

    // Nothing was fetched from anywhere but the PC itself (no CDN).
    for (const url of requests) assert.ok(url.startsWith(`${origin}/`) || url.startsWith(`blob:${origin}/`) || url.startsWith('data:'), `unexpected request to ${url}`);

    for (const { context } of [delivery, bench, irn]) await context.close();
  } finally {
    await browser.close();
    if (handle) await stopService();
    env.cleanup();
  }
});

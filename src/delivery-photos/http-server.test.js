'use strict';

// Real HTTPS requests (the actual generated certificate, actually trusted by
// the test client - not mocked), a real forked archive worker, and a real
// temp folder standing in for the network drive.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const nodePath = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const { startServers } = require('./http-server');
const { ensureCertificates } = require('./certs');
const { runInWorker } = require('./worker-runner');
const { makeEnv, jpeg, quietLogger } = require('./helpers');
const { PairingManager } = require('./auth');
const { ConcurrencyLimiter } = require('./concurrency');

process.env.DELIVERY_PHOTOS_TEST_HOOKS = '1';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// A deterministic, always-unique port per test (never random): Node's TLS
// session-resumption cache is keyed loosely enough by host:port that two
// DIFFERENT tests colliding on the same port - even sequentially, even with
// their own freshly-made https.Agent and certificate each - can make a later
// handshake spuriously fail signature verification for the earlier test's
// now-gone certificate. A random range was tried first and hit exactly this.
let nextPort = 9000;
function reservePortPair() {
  const port = nextPort;
  nextPort += 2; // the plain-HTTP bootstrap listener always uses https port + 1
  return port;
}

// A single already-paired device's token, handed to `fn` as `token` - every
// test in this file except the dedicated auth tests below is exercising
// something OTHER than pairing itself, so it needs a working, pre-paired
// token to get past the auth gate and reach the behaviour it actually means
// to test. `pairing`/`limiter` are also handed back so the auth/concurrency
// tests can drive them directly (revoke a device, exhaust the concurrency
// limit) without reaching into http-server.js's internals.
async function withServer(env, overrides, fn) {
  const config = { hostname: 'localhost', port: reservePortPair(), photoRoot: env.share, maxPhotoBytes: 5 * 1000 * 1000, operationTimeoutSeconds: 10, minFreeGb: 0, ...overrides.config };
  const credentials = ensureCertificates(nodePath.join(env.home, 'certs'), config.hostname);
  const logger = overrides.logger || quietLogger();
  const pairing = overrides.pairing || new PairingManager({ devicesPath: nodePath.join(env.home, 'paired-devices.json') });
  const limiter = overrides.limiter || new ConcurrencyLimiter();
  const queueDir = overrides.queueDir || nodePath.join(env.home, 'tracking-queue');
  const filedLogDir = nodePath.join(env.home, 'filed-sessions');
  const { token } = pairing.pair(pairing.generateCode({ role: overrides.role || 'delivery' }).code);
  const orderLocks = overrides.orderLocks;
  // photoRoot is env.share, a real local temp folder - on a real Windows
  // machine (including GitHub Actions' own runners) that is a genuine
  // drive-letter path, which production now accepts directly (see
  // archive.test.js/config.test.js/storage-test.test.js for the path-shape
  // rules themselves), so no test-only opt-in is needed here.
  const handle = startServers({ config, credentials, runWorker: overrides.runWorker || runInWorker, logger, spoolDir: env.spool, testMode: overrides.testMode, pairing, limiter, orderLocks, queueDir, filedLogDir });
  await handle.listen();
  const agent = new https.Agent({ ca: credentials.caCert });
  try {
    await fn({ config, agent, logger, handle, token, pairing, limiter, queueDir, filedLogDir });
  } finally {
    await handle.close();
    agent.destroy();
  }
}

// A server that refuses an oversized upload before fully reading the body
// (see the Content-Length pre-check in http-server.js) may close the
// connection while this client is still writing it - exactly what a real
// iPad's fetch() would also do the upload through. Once a full response has
// actually arrived, a write error on the now-moot remaining body is expected
// and ignored rather than surfacing as a spurious rejection.
function request(agent, { method, path, port, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    // Set the moment headers arrive, not only once the body finishes - a
    // write-side error on the request can otherwise race a same-tick 'end'.
    let gotResponse = false;
    const req = https.request({ agent, host: 'localhost', port, method, path, headers }, (res) => {
      gotResponse = true;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (err) => {
      if (gotResponse) return; // the answer already arrived; a late write-side error no longer matters
      reject(err);
    });
    if (body) req.end(body);
    else req.end();
  });
}

function plainRequest({ path, port }) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('serves the static iPad web app over real, trusted HTTPS', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const res = await request(agent, { method: 'GET', path: '/', port: config.port });
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.match(res.body.toString('utf8'), /<!doctype html>/i);
    });
  } finally {
    env.cleanup();
  }
});

test('serves the ONE shared reference.js from its canonical server location, not a copy', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const res = await request(agent, { method: 'GET', path: '/reference.js', port: config.port });
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /javascript/);
      const served = res.body.toString('utf8');
      const canonical = fs.readFileSync(nodePath.join(__dirname, 'reference.js'), 'utf8');
      assert.equal(served, canonical);
    });
  } finally {
    env.cleanup();
  }
});

test('refuses a client that does not trust the certificate at all', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config }) => {
      const untrusting = new https.Agent({}); // no `ca` supplied - the default system trust store, which does not know this CA
      await assert.rejects(request(untrusting, { method: 'GET', path: '/', port: config.port }));
      untrusting.destroy();
    });
  } finally {
    env.cleanup();
  }
});

test('static file serving refuses to escape its own folder', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const res = await request(agent, { method: 'GET', path: '/../../../etc/passwd', port: config.port });
      assert.notEqual(res.status, 200);
    });
  } finally {
    env.cleanup();
  }
});

test('a complete photo upload: files it on the drive and verifies it by reading it back', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const bytes = jpeg('upload-happy', 4000);
      const photoId = randomUUID();
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${photoId}`,
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes), 'Content-Length': bytes.length },
        body: bytes
      });
      const parsed = JSON.parse(res.body.toString('utf8'));
      assert.equal(res.status, 201, JSON.stringify(parsed));
      assert.equal(parsed.storagePath, '5698/001-DELIV.jpg');
      assert.deepEqual([parsed.role, parsed.baseOrder], ['delivery', '5698']);

      const onDisk = fs.readFileSync(nodePath.join(env.share, '5698', '001-DELIV.jpg'));
      assert.ok(onDisk.equals(bytes));
      assert.deepEqual(fs.readdirSync(env.spool), [], 'the local spool copy must be cleaned up');
    });
  } finally {
    env.cleanup();
  }
});

test('two photographs for the same delivery are numbered 001 and 002', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      for (let i = 1; i <= 2; i++) {
        const bytes = jpeg(`multi-${i}`, 3000);
        const res = await request(agent, {
          method: 'PUT',
          path: `/api/photos/5698-DELIV/${randomUUID()}`,
          port: config.port,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
          body: bytes
        });
        const parsed = JSON.parse(res.body.toString('utf8'));
        assert.equal(parsed.storagePath, `5698/00${i}-DELIV.jpg`);
      }
    });
  } finally {
    env.cleanup();
  }
});

test('part deliveries file into the same base order folder as the standard delivery', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const full = jpeg('full-delivery', 3000);
      await request(agent, { method: 'PUT', path: `/api/photos/5698-DELIV/${randomUUID()}`, port: config.port, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(full) }, body: full });
      const bytes = jpeg('part-delivery', 3000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-p2-deliv/${randomUUID()}`, // lower case, as a careless scan might produce
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });
      const parsed = JSON.parse(res.body.toString('utf8'));
      assert.equal(res.status, 201);
      assert.equal(parsed.storagePath, '5698/002-DELIV.jpg', 'part 2 of order 5698 goes into folder 5698, numbered after the full delivery');
      assert.deepEqual(fs.readdirSync(env.share).filter((n) => n !== '.incoming'), ['5698']);
    });
  } finally {
    env.cleanup();
  }
});

test('an invalid delivery reference is refused before anything is written', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const bytes = jpeg('bad-ref', 2000);
      for (const badRef of ['not-a-real-code', '..-DELIV', '5698-P1-DELIV']) {
        const res = await request(agent, {
          method: 'PUT',
          path: `/api/photos/${encodeURIComponent(badRef)}/${randomUUID()}`,
          port: config.port,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
          body: bytes
        });
        assert.equal(res.status, 400, badRef);
        assert.equal(JSON.parse(res.body.toString('utf8')).error, 'invalid_code');
      }
      assert.deepEqual(fs.readdirSync(env.share), []);
    });
  } finally {
    env.cleanup();
  }
});

test('a non-UUID photo id is refused', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const bytes = jpeg('bad-id', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: '/api/photos/5698-DELIV/not-a-uuid',
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });
      assert.equal(res.status, 400);
    });
  } finally {
    env.cleanup();
  }
});

test('a missing or malformed checksum header is refused', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const bytes = jpeg('no-checksum', 2000);
      for (const bad of [{}, { 'X-Photo-Sha256': 'not-hex' }, { 'X-Photo-Sha256': 'abcd' }]) {
        const res = await request(agent, { method: 'PUT', path: `/api/photos/5698-DELIV/${randomUUID()}`, port: config.port, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', ...bad }, body: bytes });
        assert.equal(res.status, 400, JSON.stringify(bad));
      }
    });
  } finally {
    env.cleanup();
  }
});

test('a checksum that does not match what was declared is rejected, and nothing is written', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const bytes = jpeg('mismatch', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(Buffer.from('something else entirely')) },
        body: bytes
      });
      assert.equal(res.status, 409);
      assert.deepEqual(fs.readdirSync(env.share), []);
    });
  } finally {
    env.cleanup();
  }
});

test('something that is not really a JPEG is refused even with a correct-looking checksum', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const bytes = Buffer.from('this is not a real jpeg file, just plain text padded out'.repeat(5));
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });
      assert.equal(res.status, 400);
    });
  } finally {
    env.cleanup();
  }
});

test('a wrong content-type is refused', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const bytes = jpeg('wrong-type', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });
      assert.equal(res.status, 400);
    });
  } finally {
    env.cleanup();
  }
});

test('an over-limit upload is refused from its declared Content-Length alone, before the body is read', async () => {
  const env = makeEnv();
  try {
    await withServer(env, { config: { maxPhotoBytes: 500000 } }, async ({ config, agent, token }) => {
      // Declares a 900 KB body (as a real browser honestly would for a File/Blob
      // this size) but only ever WRITES a small fragment of it - proving the
      // refusal comes from the header alone, since the real bytes never arrive.
      const response = await new Promise((resolve, reject) => {
        const req = https.request(
          { agent, host: 'localhost', port: config.port, method: 'PUT', path: `/api/photos/5698-DELIV/${randomUUID()}`, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(jpeg('too-big-declared', 900000)), 'Content-Length': 900000 } },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
          }
        );
        req.on('error', reject);
        req.write(Buffer.alloc(1000, 1)); // a small fragment only - well under the declared length
        // deliberately never call req.end() with the rest - the point is the
        // server must not need it in order to answer
      });

      assert.equal(response.status, 413);
      assert.match(JSON.parse(response.body.toString('utf8')).message, /larger than/);
      assert.deepEqual(fs.readdirSync(env.share), []);
    });
  } finally {
    env.cleanup();
  }
});

test('when the network drive cannot be reached, a clear, retryable error comes back and the photo stays only in the spool cleanup path (nothing left behind)', async () => {
  const env = makeEnv();
  try {
    await withServer(env, { config: { photoRoot: nodePath.join(env.share, 'does-not-exist') } }, async ({ config, agent, token }) => {
      const bytes = jpeg('no-drive', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });
      const parsed = JSON.parse(res.body.toString('utf8'));
      assert.equal(res.status, 502);
      assert.equal(parsed.retryable, true);
      assert.deepEqual(fs.readdirSync(env.spool), []);
    });
  } finally {
    env.cleanup();
  }
});

test('the health endpoint answers without touching the drive at all', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const res = await request(agent, { method: 'GET', path: '/api/health', port: config.port });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body.toString('utf8')).hostname, config.hostname);
    });
  } finally {
    env.cleanup();
  }
});

test('an unsupported method on the upload path is refused', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const res = await request(agent, { method: 'DELETE', path: `/api/photos/5698-DELIV/${randomUUID()}`, port: config.port });
      assert.equal(res.status, 405);
    });
  } finally {
    env.cleanup();
  }
});

test('the plain-HTTP listener serves only the trust profile, and redirects everything else to HTTPS', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config }) => {
      const profile = await plainRequest({ path: '/trust.mobileconfig', port: config.port + 1 });
      assert.equal(profile.status, 200);
      assert.equal(profile.headers['content-type'], 'application/x-apple-aspen-config');
      assert.match(profile.body.toString('utf8'), /PayloadType/);

      const other = await plainRequest({ path: '/', port: config.port + 1 });
      assert.equal(other.status, 302);
      assert.equal(other.headers.location, `https://${config.hostname}:${config.port}/`);
    });
  } finally {
    env.cleanup();
  }
});

// ---- Pairing / authentication (fix 1) --------------------------------------

test('an upload with no Authorization header at all is rejected as unauthorized, and nothing is written', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent }) => {
      const bytes = jpeg('no-auth', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });
      assert.equal(res.status, 401);
      assert.deepEqual(fs.readdirSync(env.share), []);
    });
  } finally {
    env.cleanup();
  }
});

test('an upload with a garbage/unknown bearer token is rejected exactly like no token at all', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent }) => {
      const bytes = jpeg('fake-token', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: 'Bearer this-was-never-issued-by-anyone', 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });
      assert.equal(res.status, 401);
    });
  } finally {
    env.cleanup();
  }
});

test('a paired devices token is accepted for an upload (every other test in this file already relies on this)', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const bytes = jpeg('paired-ok', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });
      assert.equal(res.status, 201);
    });
  } finally {
    env.cleanup();
  }
});

test('once a device is revoked, its previously-working token is rejected on the very next upload', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token, pairing }) => {
      const before = jpeg('before-revoke', 2000);
      const beforeRes = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(before) },
        body: before
      });
      assert.equal(beforeRes.status, 201, 'sanity check: the token works before revocation');

      pairing.revokeAll();

      const after = jpeg('after-revoke', 2000);
      const afterRes = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(after) },
        body: after
      });
      assert.equal(afterRes.status, 401, 'the same token must no longer work once revoked');
    });
  } finally {
    env.cleanup();
  }
});

test('POST /api/pair: the right code issues a token that really works for an upload; the wrong code is refused', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, pairing }) => {
      const { code } = pairing.generateCode({ role: 'delivery' });
      const paired = await request(agent, {
        method: 'POST',
        path: '/api/pair',
        port: config.port,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ code }))
      });
      assert.equal(paired.status, 200);
      const issuedToken = JSON.parse(paired.body.toString('utf8')).token;
      assert.ok(issuedToken);

      const bytes = jpeg('newly-paired', 2000);
      const uploadRes = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: `Bearer ${issuedToken}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });
      assert.equal(uploadRes.status, 201, 'the freshly issued token must actually work for a real upload');

      pairing.generateCode({ role: 'delivery' }); // a fresh code, so the wrong-code attempt below has something active to fail against
      const wrong = await request(agent, {
        method: 'POST',
        path: '/api/pair',
        port: config.port,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ code: 'WRONGCOD' }))
      });
      assert.equal(wrong.status, 401);
      assert.equal(JSON.parse(wrong.body.toString('utf8')).error, 'wrong_code');
    });
  } finally {
    env.cleanup();
  }
});

test('GET /api/pair/check reports whether the presented token is currently paired, without needing a real upload', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      const paired = await request(agent, { method: 'GET', path: '/api/pair/check', port: config.port, headers: { Authorization: `Bearer ${token}` } });
      assert.equal(JSON.parse(paired.body.toString('utf8')).paired, true);

      const unpaired = await request(agent, { method: 'GET', path: '/api/pair/check', port: config.port, headers: { Authorization: 'Bearer garbage' } });
      assert.equal(JSON.parse(unpaired.body.toString('utf8')).paired, false);

      const noHeader = await request(agent, { method: 'GET', path: '/api/pair/check', port: config.port });
      assert.equal(JSON.parse(noHeader.body.toString('utf8')).paired, false);
    });
  } finally {
    env.cleanup();
  }
});

// ---- Concurrency / rate protection (fix 2) ---------------------------------

test('a request beyond the concurrency limit is rejected cleanly with a retryable 429 and Retry-After, while the other still succeeds', async () => {
  const env = makeEnv();
  try {
    const tinyLimiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 0, maxWaitMs: 200 });
    await withServer(env, { limiter: tinyLimiter }, async ({ config, agent, token }) => {
      const makeRequest = () => {
        const bytes = jpeg(`concurrency-${randomUUID()}`, 3000);
        return request(agent, {
          method: 'PUT',
          path: `/api/photos/5698-DELIV/${randomUUID()}`,
          port: config.port,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
          body: bytes
        });
      };

      // Fired together, deliberately not awaited one at a time - the whole
      // point is that both requests are genuinely in flight at once.
      const [a, b] = await Promise.all([makeRequest(), makeRequest()]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 429], `expected one accepted and one rejected, got ${JSON.stringify(statuses)}`);

      const busy = a.status === 429 ? a : b;
      const parsedBusy = JSON.parse(busy.body.toString('utf8'));
      assert.equal(parsedBusy.retryable, true);
      assert.ok(busy.headers['retry-after'], 'a busy response must tell the client when to retry');
    });
  } finally {
    env.cleanup();
  }
});

test('normal multi-photo uploads for one delivery (well under the concurrency limit) all still succeed', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      for (let i = 1; i <= 3; i++) {
        const bytes = jpeg(`multi-ok-${i}`, 2000);
        const res = await request(agent, {
          method: 'PUT',
          path: `/api/photos/5698-DELIV/${randomUUID()}`,
          port: config.port,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
          body: bytes
        });
        assert.equal(res.status, 201, `photo ${i} must still succeed under the default concurrency limit`);
      }
    });
  } finally {
    env.cleanup();
  }
});

// ---- minFreeGb enforcement (fix 3) ------------------------------------------

test('insufficient free space is reported to the iPad as a clear, retryable 507, and nothing is written', async () => {
  const env = makeEnv();
  try {
    await withServer(env, { config: { minFreeGb: 999999999 } }, async ({ config, agent, token }) => {
      const bytes = jpeg('no-space-http', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });
      const parsed = JSON.parse(res.body.toString('utf8'));
      assert.equal(res.status, 507);
      assert.equal(parsed.retryable, true);
      assert.deepEqual(fs.readdirSync(env.share), []);
    });
  } finally {
    env.cleanup();
  }
});

// ---- Audit logging (fix 4) --------------------------------------------------

test('successful uploads, unauthenticated attempts, and failed pairing attempts all log the requesting IP, and never a token or pairing code', async () => {
  const env = makeEnv();
  try {
    const logger = quietLogger();
    await withServer(env, { logger }, async ({ config, agent, token, pairing }) => {
      const bytes = jpeg('ip-log', 2000);
      await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
        body: bytes
      });

      await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) }, // no Authorization at all
        body: bytes
      });

      const pairingCode = pairing.generateCode({ role: 'delivery' }).code;
      await request(agent, {
        method: 'POST',
        path: '/api/pair',
        port: config.port,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ code: 'WRONGCOD' }))
      });

      const logged = logger.lines.join('\n');
      assert.match(logged, /127\.0\.0\.1|::1/, 'the requesting IP must appear in the logs');
      assert.ok(!logged.includes(token), 'the real bearer token must never be logged');
      assert.ok(!logged.includes(pairingCode), 'a pairing code must never be logged');
    });
  } finally {
    env.cleanup();
  }
});

// ---- Delivery-photo tracking events (POST /api/delivery-sessions/complete) -

const { listPendingEvents } = require('./tracking');

test('a completed session with no auth is rejected, and nothing is queued', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, queueDir }) => {
      const res = await request(agent, {
        method: 'POST',
        path: '/api/delivery-sessions/complete',
        port: config.port,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ reference: '5698-DELIV', photosSaved: 2 }))
      });
      assert.equal(res.status, 401);
      assert.deepEqual(listPendingEvents(queueDir), []);
    });
  } finally {
    env.cleanup();
  }
});

test('a paired device reporting a completed session queues a tracking event with the right fields', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token, queueDir }) => {
      const res = await request(agent, {
        method: 'POST',
        path: '/api/delivery-sessions/complete',
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ reference: '5698-p2-deliv', photosSaved: 4 }))
      });
      assert.equal(res.status, 201);
      const parsed = JSON.parse(res.body.toString('utf8'));
      assert.ok(parsed.eventId);

      const pending = listPendingEvents(queueDir);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].eventId, parsed.eventId);
      assert.equal(pending[0].reference, '5698-P2-DELIV');
      assert.equal(pending[0].orderNumber, '5698');
      assert.equal(pending[0].deliveryType, 'Part Delivery');
      assert.equal(pending[0].partNo, 2);
      assert.equal(pending[0].photosSaved, 4);
    });
  } finally {
    env.cleanup();
  }
});

test('an invalid delivery reference or a non-positive photo count is refused, and nothing is queued', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token, queueDir }) => {
      for (const body of [{ reference: 'not-a-code', photosSaved: 1 }, { reference: '5698-DELIV', photosSaved: 0 }, { reference: '5698-DELIV', photosSaved: 'two' }]) {
        const res = await request(agent, {
          method: 'POST',
          path: '/api/delivery-sessions/complete',
          port: config.port,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(body))
        });
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.deepEqual(listPendingEvents(queueDir), []);
    });
  } finally {
    env.cleanup();
  }
});

test('tracking events log the requesting IP, and never a token', async () => {
  const env = makeEnv();
  try {
    const logger = quietLogger();
    await withServer(env, { logger }, async ({ config, agent, token }) => {
      await request(agent, {
        method: 'POST',
        path: '/api/delivery-sessions/complete',
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ reference: '5698-DELIV', photosSaved: 1 }))
      });
      const logged = logger.lines.join('\n');
      assert.match(logged, /127\.0\.0\.1|::1/);
      assert.ok(!logged.includes(token));
    });
  } finally {
    env.cleanup();
  }
});

test('completed sessions feed "Orders filed today" by unique order number; refused ones do not', async () => {
  const { countOrdersFiledOn } = require('./filed-today');
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token, filedLogDir }) => {
      const complete = (reference, headers = { Authorization: `Bearer ${token}` }) =>
        request(agent, {
          method: 'POST',
          path: '/api/delivery-sessions/complete',
          port: config.port,
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ reference, photosSaved: 2 }))
        });

      for (const ref of ['5698-DELIV', '5698-P-DELIV', '5698-P2-DELIV', '5701-DELIV', '5702-P-DELIV']) {
        assert.equal((await complete(ref)).status, 201);
      }
      assert.equal((await complete('5800-DELIV', {})).status, 401);
      assert.equal((await complete('not-a-code')).status, 400);

      assert.equal(countOrdersFiledOn(filedLogDir), 3);
    });
  } finally {
    env.cleanup();
  }
});

test('end to end: saved photos then session-complete feed the queue and "Orders filed today"; a failed session does not', async () => {
  const { countOrdersFiledOn } = require('./filed-today');
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token, queueDir, filedLogDir }) => {
      const auth = { Authorization: `Bearer ${token}` };
      const upload = (reference, bytes, checksum = sha256(bytes)) =>
        request(agent, {
          method: 'PUT',
          path: `/api/photos/${reference}/${randomUUID()}`,
          port: config.port,
          headers: { ...auth, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': checksum },
          body: bytes
        });
      const complete = (reference, photosSaved) =>
        request(agent, {
          method: 'POST',
          path: '/api/delivery-sessions/complete',
          port: config.port,
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ reference, photosSaved }))
        });

      // What the iPad does for a successful session: every photo comes back
      // 201 (saved and read back), and only then is the session reported.
      async function successfulSession(reference, photos) {
        for (let i = 0; i < photos; i++) assert.equal((await upload(reference, jpeg(`${reference}-${i}`, 2500))).status, 201);
        assert.equal((await complete(reference, photos)).status, 201);
      }

      await successfulSession('5698-DELIV', 2);
      await successfulSession('5698-P-DELIV', 1);
      await successfulSession('5698-P2-DELIV', 3);
      assert.equal(listPendingEvents(queueDir).length, 3, 'one tracking event per completed session');
      assert.equal(countOrdersFiledOn(filedLogDir), 1, 'three sessions of order 5698 are one order');

      await successfulSession('5701-DELIV', 1);
      assert.equal(countOrdersFiledOn(filedLogDir), 2);

      // A failed session: one photo saved, one rejected - the iPad never
      // reports it complete, so it creates no event and is not counted.
      assert.equal((await upload('5702-DELIV', jpeg('5702-ok', 2500))).status, 201);
      assert.notEqual((await upload('5702-DELIV', jpeg('5702-bad', 2500), sha256(Buffer.from('wrong')))).status, 201);
      assert.equal(listPendingEvents(queueDir).length, 4);
      assert.equal(countOrdersFiledOn(filedLogDir), 2);

      assert.deepEqual(fs.readdirSync(nodePath.join(env.share, '5698')).sort(), ['001-DELIV.jpg', '002-DELIV.jpg', '003-DELIV.jpg', '004-DELIV.jpg', '005-DELIV.jpg', '006-DELIV.jpg'], 'all six photos of order 5698 (full, part 1, part 2) really are on the drive, in one folder');
    });
  } finally {
    env.cleanup();
  }
});

// ---- Offline support: idempotent session completion, app shell ------------

test('reporting the same session twice (an iPad retry) creates one tracking event, one ledger line', async () => {
  const { countOrdersFiledOn } = require('./filed-today');
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token, queueDir, filedLogDir }) => {
      const sessionId = randomUUID();
      const complete = () =>
        request(agent, {
          method: 'POST',
          path: '/api/delivery-sessions/complete',
          port: config.port,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ sessionId, reference: '5698-DELIV', photosSaved: 2 }))
        });
      const first = await complete();
      assert.equal(first.status, 201);
      assert.equal(JSON.parse(first.body.toString('utf8')).eventId, sessionId);
      const second = await complete();
      assert.equal(second.status, 200);
      assert.equal(JSON.parse(second.body.toString('utf8')).duplicate, true);

      const pending = listPendingEvents(queueDir);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].eventId, sessionId);
      assert.equal(fs.readFileSync(nodePath.join(filedLogDir, fs.readdirSync(filedLogDir)[0]), 'utf8').trim().split('\n').length, 1);
      assert.equal(countOrdersFiledOn(filedLogDir), 1);
    });
  } finally {
    env.cleanup();
  }
});

test('a malformed session id is refused and nothing is queued', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token, queueDir }) => {
      const res = await request(agent, {
        method: 'POST',
        path: '/api/delivery-sessions/complete',
        port: config.port,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ sessionId: '../escape', reference: '5698-DELIV', photosSaved: 1 }))
      });
      assert.equal(res.status, 400);
      assert.deepEqual(listPendingEvents(queueDir), []);
    });
  } finally {
    env.cleanup();
  }
});

test('serves the offline Service Worker (versioned, never cached), the manifest and the icons', async () => {
  const { shellVersion } = require('./web-shell');
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent }) => {
      const sw = await request(agent, { method: 'GET', path: '/sw.js', port: config.port });
      assert.equal(sw.status, 200);
      assert.match(sw.headers['content-type'], /javascript/);
      assert.equal(sw.headers['cache-control'], 'no-store');
      assert.match(sw.body.toString('utf8'), new RegExp(shellVersion()));

      const manifest = await request(agent, { method: 'GET', path: '/manifest.webmanifest', port: config.port });
      assert.equal(manifest.status, 200);
      assert.match(manifest.headers['content-type'], /application\/manifest\+json/);

      for (const icon of ['/icon-180.png', '/icon-512.png']) {
        const res = await request(agent, { method: 'GET', path: icon, port: config.port });
        assert.equal(res.status, 200, icon);
        assert.equal(res.headers['content-type'], 'image/png');
      }
    });
  } finally {
    env.cleanup();
  }
});

// ---- Photo roles: Delivery, Bench, Ironmongery --------------------------------

const pairAs = (pairing, role, name) => pairing.pair(pairing.generateCode({ role, name }).code).token;

function upload(agent, port, token, code, bytes, extraHeaders = {}) {
  return request(agent, {
    method: 'PUT',
    path: `/api/photos/${encodeURIComponent(code)}/${extraHeaders.photoId || randomUUID()}`,
    port,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes), ...extraHeaders.headers },
    body: bytes
  }).then((res) => ({ status: res.status, body: JSON.parse(res.body.toString('utf8') || '{}') }));
}

function completeAs(agent, port, token, body, { path = '/api/photo-sessions/complete', headers = {} } = {}) {
  return request(agent, {
    method: 'POST',
    path,
    port,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(body))
  }).then((res) => ({ status: res.status, body: JSON.parse(res.body.toString('utf8') || '{}') }));
}

const orderFiles = (env, folder) => {
  try {
    return fs.readdirSync(nodePath.join(env.share, folder)).sort();
  } catch {
    return [];
  }
};

test('a Bench iPad files door and frame labels under the base order, as -BENCH, whatever the unit', async () => {
  const env = makeEnv();
  try {
    await withServer(env, { role: 'bench' }, async ({ config, agent, token }) => {
      const results = [];
      for (const code of ['5698-D-01', '5698-F-07', '5698-D-17', '5626-2-D-01', '5626-2-F-03']) {
        const res = await upload(agent, config.port, token, code, jpeg(`bench-${code}`, 2500));
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.role, 'bench');
        results.push(res.body.storagePath);
      }
      assert.deepEqual(results, ['5698/001-BENCH.jpg', '5698/002-BENCH.jpg', '5698/003-BENCH.jpg', '5626-2/001-BENCH.jpg', '5626-2/002-BENCH.jpg']);
    });
  } finally {
    env.cleanup();
  }
});

test('an Ironmongery iPad files a plain order number as -IRN', async () => {
  const env = makeEnv();
  try {
    await withServer(env, { role: 'ironmongery' }, async ({ config, agent, token }) => {
      assert.equal((await upload(agent, config.port, token, '5698', jpeg('irn-1', 2500))).body.storagePath, '5698/001-IRN.jpg');
      assert.equal((await upload(agent, config.port, token, '5626-2', jpeg('irn-2', 2500))).body.storagePath, '5626-2/001-IRN.jpg');
      assert.equal((await upload(agent, config.port, token, '5698', jpeg('irn-3', 2500))).body.storagePath, '5698/002-IRN.jpg');
    });
  } finally {
    env.cleanup();
  }
});

test('every role refuses the other roles\' codes (and malformed ones), and nothing is written', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token: deliveryToken, pairing }) => {
      const tokens = { delivery: deliveryToken, bench: pairAs(pairing, 'bench'), ironmongery: pairAs(pairing, 'ironmongery') };
      const refused = {
        delivery: ['5698-D-01', '5698', '5626-2', '5698-IRN', '5698-BENCH'],
        bench: ['5698-DELIV', '5698-P2-DELIV', '5698', '5698-D', '5698-D-1', '5698-X-01', '5698-D-00', '..%2F5698-D-01'],
        ironmongery: ['5698-DELIV', '5698-D-01', '5698-IRN', '..', '..%2F..%2Fetc', '5698%5Cevil', 'CON', '5626--2', '5698-']
      };
      for (const [role, codes] of Object.entries(refused)) {
        for (const code of codes) {
          const res = await request(agent, { method: 'PUT', path: `/api/photos/${code}/${randomUUID()}`, port: config.port, headers: { Authorization: `Bearer ${tokens[role]}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(jpeg('x', 1500)) }, body: jpeg('x', 1500) });
          assert.ok(res.status >= 400, `${role} must refuse ${code} (got ${res.status})`);
        }
      }
      assert.deepEqual(fs.readdirSync(env.share), [], 'nothing created on the drive');
    });
  } finally {
    env.cleanup();
  }
});

test('the role cannot be spoofed: a Bench token is Bench whatever the request says', async () => {
  const env = makeEnv();
  try {
    await withServer(env, { role: 'bench' }, async ({ config, agent, token }) => {
      // Claiming Delivery outright is refused with a clear role mismatch.
      const claimed = await upload(agent, config.port, token, '5698-DELIV', jpeg('spoof-1', 2000), { headers: { 'X-Photo-Role': 'delivery' } });
      assert.equal(claimed.status, 403);
      assert.equal(claimed.body.error, 'role_mismatch');
      // A role in the query string means nothing.
      const query = await request(agent, { method: 'PUT', path: `/api/photos/5698-DELIV/${randomUUID()}?role=delivery`, port: config.port, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(jpeg('spoof-2', 2000)) }, body: jpeg('spoof-2', 2000) });
      assert.equal(query.status, 400);
      assert.deepEqual(fs.readdirSync(env.share), [], 'no -DELIV file, no folder');

      // Its own role claimed honestly is fine, and still files as BENCH.
      const honest = await upload(agent, config.port, token, '5698-D-03', jpeg('honest', 2000), { headers: { 'X-Photo-Role': 'bench' } });
      assert.equal(honest.status, 201);
      assert.equal(honest.body.storagePath, '5698/001-BENCH.jpg');
    });
  } finally {
    env.cleanup();
  }
});

test('an Ironmongery token can never produce a -DELIV or -BENCH file', async () => {
  const env = makeEnv();
  try {
    await withServer(env, { role: 'ironmongery' }, async ({ config, agent, token }) => {
      for (const [code, headers] of [['5698-DELIV', {}], ['5698-D-01', {}], ['5698', { 'X-Photo-Role': 'delivery' }], ['5698', { 'X-Photo-Role': 'bench' }]]) {
        const res = await upload(agent, config.port, token, code, jpeg(`irn-spoof-${code}`, 2000), { headers });
        assert.notEqual(res.status, 201, `${code} ${JSON.stringify(headers)}`);
      }
      assert.equal((await upload(agent, config.port, token, '5698', jpeg('irn-ok', 2000))).body.storagePath, '5698/001-IRN.jpg');
      assert.deepEqual(orderFiles(env, '5698'), ['001-IRN.jpg']);
    });
  } finally {
    env.cleanup();
  }
});

test('pairing hands the iPad its PC-chosen role; anything else in the pairing request is ignored', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, pairing }) => {
      const { code } = pairing.generateCode({ role: 'ironmongery', name: 'Stores iPad' });
      const res = await request(agent, { method: 'POST', path: '/api/pair', port: config.port, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ code, role: 'delivery', name: 'Hacker' })) });
      const body = JSON.parse(res.body.toString('utf8'));
      assert.equal(res.status, 200);
      assert.deepEqual([body.role, body.name], ['ironmongery', 'Stores iPad']);

      const check = await request(agent, { method: 'GET', path: '/api/pair/check', port: config.port, headers: { Authorization: `Bearer ${body.token}` } });
      assert.deepEqual(JSON.parse(check.body.toString('utf8')), { paired: true, role: 'ironmongery', name: 'Stores iPad' });
      const unpaired = await request(agent, { method: 'GET', path: '/api/pair/check', port: config.port, headers: { Authorization: `Bearer ${'0'.repeat(64)}` } });
      assert.deepEqual(JSON.parse(unpaired.body.toString('utf8')), { paired: false });
    });
  } finally {
    env.cleanup();
  }
});

test('revoking one device stops only that iPad uploading', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token, pairing }) => {
      const benchToken = pairAs(pairing, 'bench');
      const benchId = pairing.verify(benchToken).deviceId;
      assert.equal(pairing.revokeDevice(benchId), true);
      assert.equal((await upload(agent, config.port, benchToken, '5698-D-01', jpeg('revoked', 2000))).status, 401);
      assert.equal((await upload(agent, config.port, token, '5698-DELIV', jpeg('still-ok', 2000))).status, 201);
    });
  } finally {
    env.cleanup();
  }
});

test('session complete: Delivery still creates its Sheet event with Full/Part from the scan; Bench and Ironmongery create none', async () => {
  const { countOrdersFiledOn } = require('./filed-today');
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token, pairing, queueDir, filedLogDir }) => {
      const bench = pairAs(pairing, 'bench');
      const irn = pairAs(pairing, 'ironmongery');

      // Bench photos first, so the delivery photos are numbered after them.
      assert.equal((await upload(agent, config.port, bench, '5698-D-07', jpeg('b1', 2500))).body.storagePath, '5698/001-BENCH.jpg');
      const benchDone = await completeAs(agent, config.port, bench, { sessionId: randomUUID(), code: '5698-D-07', photosSaved: 1 });
      assert.deepEqual([benchDone.status, benchDone.body.role, benchDone.body.tracked], [201, 'bench', false]);
      const irnDone = await completeAs(agent, config.port, irn, { sessionId: randomUUID(), code: '5626-2', photosSaved: 3 });
      assert.deepEqual([irnDone.status, irnDone.body.tracked], [201, false]);
      assert.deepEqual(listPendingEvents(queueDir), [], 'Bench/Ironmongery never reach the Delivery sheet');
      assert.equal(countOrdersFiledOn(filedLogDir), 0, 'and never count as orders filed');

      // Delivery 5698-P2-DELIV: files land as 002/003-DELIV, the event still says Part Delivery 2.
      assert.equal((await upload(agent, config.port, token, '5698-P2-DELIV', jpeg('d1', 2500))).body.storagePath, '5698/002-DELIV.jpg');
      assert.equal((await upload(agent, config.port, token, '5698-P2-DELIV', jpeg('d2', 2500))).body.storagePath, '5698/003-DELIV.jpg');
      const sessionId = randomUUID();
      const done = await completeAs(agent, config.port, token, { sessionId, code: '5698-P2-DELIV', photosSaved: 2, role: 'bench' });
      assert.deepEqual([done.status, done.body.tracked, done.body.eventId], [201, true, sessionId]);
      const [event] = listPendingEvents(queueDir);
      assert.deepEqual(
        [event.orderNumber, event.reference, event.deliveryType, event.partNo, event.photosSaved, event.eventId],
        ['5698', '5698-P2-DELIV', 'Part Delivery', 2, 2, sessionId]
      );
      assert.equal(countOrdersFiledOn(filedLogDir), 1);
      assert.deepEqual(orderFiles(env, '5698'), ['001-BENCH.jpg', '002-DELIV.jpg', '003-DELIV.jpg']);

      // The same session reported again (a retry): no second event.
      assert.equal((await completeAs(agent, config.port, token, { sessionId, code: '5698-P2-DELIV', photosSaved: 2 })).body.duplicate, true);
      assert.equal(listPendingEvents(queueDir).length, 1);
    });
  } finally {
    env.cleanup();
  }
});

test('session complete is role-checked too: other roles\' codes, the legacy Delivery route, and role claims', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token, pairing, queueDir }) => {
      const bench = pairAs(pairing, 'bench');
      // A Bench token cannot complete a Delivery code on either route.
      assert.equal((await completeAs(agent, config.port, bench, { sessionId: randomUUID(), code: '5698-DELIV', photosSaved: 1 })).status, 400);
      const legacy = await completeAs(agent, config.port, bench, { reference: '5698-DELIV', photosSaved: 1 }, { path: '/api/delivery-sessions/complete' });
      assert.deepEqual([legacy.status, legacy.body.error], [403, 'role_mismatch']);
      const claimed = await completeAs(agent, config.port, bench, { sessionId: randomUUID(), code: '5698-D-01', photosSaved: 1 }, { headers: { 'X-Photo-Role': 'delivery' } });
      assert.deepEqual([claimed.status, claimed.body.error], [403, 'role_mismatch']);
      assert.deepEqual(listPendingEvents(queueDir), []);

      // The legacy route still works for a Delivery iPad still running the previous page.
      const old = await completeAs(agent, config.port, token, { reference: '5701-DELIV', photosSaved: 1 }, { path: '/api/delivery-sessions/complete' });
      assert.equal(old.status, 201);
      assert.equal(listPendingEvents(queueDir).length, 1);

      // Malformed sessions are refused for every role.
      for (const body of [{ code: '5698-D-01', photosSaved: 0 }, { code: '5698-D-01', photosSaved: 'two' }, { code: '5698-D-01', photosSaved: 1, sessionId: '../x' }, { photosSaved: 1 }]) {
        assert.equal((await completeAs(agent, config.port, bench, body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await completeAs(agent, config.port, 'f'.repeat(64), { code: '5698-D-01', photosSaved: 1 })).status, 401);
    });
  } finally {
    env.cleanup();
  }
});

test('concurrent saves from several iPads into one order folder: every photo gets its own number, nothing is overwritten', async () => {
  const env = makeEnv();
  try {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 12, maxQueue: 12, maxWaitMs: 60000 });
    await withServer(env, { limiter }, async ({ config, agent, token, pairing }) => {
      fs.mkdirSync(nodePath.join(env.share, '5698'));
      fs.writeFileSync(nodePath.join(env.share, '5698', '001-DELIV.jpg'), 'already here');
      const tokens = { delivery: token, bench: pairAs(pairing, 'bench'), ironmongery: pairAs(pairing, 'ironmongery') };
      const codes = { delivery: '5698-P2-DELIV', bench: '5698-D-04', ironmongery: '5698' };
      const sent = [];
      for (let i = 0; i < 9; i++) {
        const role = ['delivery', 'bench', 'ironmongery'][i % 3];
        sent.push({ role, bytes: jpeg(`concurrent-${i}`, 2000 + i * 7) });
      }
      const results = await Promise.all(sent.map((s) => upload(agent, config.port, tokens[s.role], codes[s.role], s.bytes)));
      for (const r of results) assert.equal(r.status, 201, JSON.stringify(r.body));

      const names = results.map((r) => r.body.storagePath.split('/')[1]);
      const numbers = names.map((n) => Number(n.slice(0, 3))).sort((a, b) => a - b);
      assert.deepEqual(numbers, [2, 3, 4, 5, 6, 7, 8, 9, 10], 'nine distinct numbers after the existing 001');
      assert.equal(fs.readFileSync(nodePath.join(env.share, '5698', '001-DELIV.jpg'), 'utf8'), 'already here');
      results.forEach((r, i) => {
        assert.ok(r.body.storagePath.endsWith(`-${{ delivery: 'DELIV', bench: 'BENCH', ironmongery: 'IRN' }[sent[i].role]}.jpg`));
        assert.ok(fs.readFileSync(nodePath.join(env.share, r.body.storagePath)).equals(sent[i].bytes), `${r.body.storagePath} holds exactly the photo that was sent`);
      });
      assert.equal(orderFiles(env, '5698').length, 10);
      assert.deepEqual(fs.readdirSync(env.spool), []);
    });
  } finally {
    env.cleanup();
  }
});

test('the same photo retried several times at once is filed once and uses one number', async () => {
  const env = makeEnv();
  try {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 8, maxQueue: 8, maxWaitMs: 60000 });
    await withServer(env, { role: 'bench', limiter }, async ({ config, agent, token }) => {
      const bytes = jpeg('retry-storm', 2400);
      const photoId = randomUUID();
      const results = await Promise.all(Array.from({ length: 4 }, () => upload(agent, config.port, token, '5626-2-F-03', bytes, { photoId })));
      for (const r of results) assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([...new Set(results.map((r) => r.body.storagePath))], ['5626-2/001-BENCH.jpg']);
      assert.deepEqual(orderFiles(env, '5626-2'), ['001-BENCH.jpg']);
      assert.equal((await upload(agent, config.port, token, '5626-2-D-01', jpeg('next', 2400))).body.storagePath, '5626-2/002-BENCH.jpg');
    });
  } finally {
    env.cleanup();
  }
});

test('historical <ORDER>-DELIV folders are not touched by new uploads', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
      fs.mkdirSync(nodePath.join(env.share, '5698-DELIV'));
      fs.writeFileSync(nodePath.join(env.share, '5698-DELIV', 'photo-001.jpg'), 'historical');
      const mtime = fs.statSync(nodePath.join(env.share, '5698-DELIV', 'photo-001.jpg')).mtimeMs;
      const res = await upload(agent, config.port, token, '5698-DELIV', jpeg('new-layout', 2500));
      assert.equal(res.body.storagePath, '5698/001-DELIV.jpg');
      assert.deepEqual(orderFiles(env, '5698-DELIV'), ['photo-001.jpg']);
      assert.equal(fs.readFileSync(nodePath.join(env.share, '5698-DELIV', 'photo-001.jpg'), 'utf8'), 'historical');
      assert.equal(fs.statSync(nodePath.join(env.share, '5698-DELIV', 'photo-001.jpg')).mtimeMs, mtime);
    });
  } finally {
    env.cleanup();
  }
});

test('serves the ONE shared photo-roles.js from its canonical server location', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent }) => {
      const res = await request(agent, { method: 'GET', path: '/photo-roles.js', port: config.port });
      assert.equal(res.status, 200);
      assert.equal(res.body.toString('utf8'), fs.readFileSync(nodePath.join(__dirname, 'photo-roles.js'), 'utf8'));
    });
  } finally {
    env.cleanup();
  }
});

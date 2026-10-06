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
  const { token } = pairing.pair(pairing.generateCode().code);
  // photoRoot is env.share, a real local temp folder - on a real Windows
  // machine (including GitHub Actions' own runners) that is a genuine
  // drive-letter path, which production now accepts directly (see
  // archive.test.js/config.test.js/storage-test.test.js for the path-shape
  // rules themselves), so no test-only opt-in is needed here.
  const handle = startServers({ config, credentials, runWorker: overrides.runWorker || runInWorker, logger, spoolDir: env.spool, testMode: overrides.testMode, pairing, limiter, queueDir, filedLogDir });
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
      assert.equal(parsed.storagePath, '5698-DELIV/photo-001.jpg');

      const onDisk = fs.readFileSync(nodePath.join(env.share, '5698-DELIV', 'photo-001.jpg'));
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
        assert.equal(parsed.storagePath, `5698-DELIV/photo-00${i}.jpg`);
      }
    });
  } finally {
    env.cleanup();
  }
});

test('part deliveries get their own folder, separate from the standard delivery', async () => {
  const env = makeEnv();
  try {
    await withServer(env, {}, async ({ config, agent, token }) => {
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
      assert.equal(parsed.storagePath, '5698-P2-DELIV/photo-001.jpg', 'normalised to the canonical upper-case folder name');
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
      const { code } = pairing.generateCode();
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

      pairing.generateCode(); // a fresh code, so the wrong-code attempt below has something active to fail against
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

      const pairingCode = pairing.generateCode().code;
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

      assert.equal(fs.readdirSync(nodePath.join(env.share, '5698-P2-DELIV')).length, 3, 'photos really are on the drive');
    });
  } finally {
    env.cleanup();
  }
});

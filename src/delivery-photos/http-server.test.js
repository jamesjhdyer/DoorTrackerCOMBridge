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

async function withServer(env, overrides, fn) {
  const config = { hostname: 'localhost', port: reservePortPair(), photoRoot: env.share, maxPhotoBytes: 5 * 1000 * 1000, operationTimeoutSeconds: 10, ...overrides.config };
  const credentials = ensureCertificates(nodePath.join(env.home, 'certs'), config.hostname);
  const logger = overrides.logger || quietLogger();
  const handle = startServers({ config, credentials, runWorker: overrides.runWorker || runInWorker, logger, spoolDir: env.spool, allowDriveLetter: false, testMode: overrides.testMode });
  await handle.listen();
  const agent = new https.Agent({ ca: credentials.caCert });
  try {
    await fn({ config, agent, logger, handle });
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
    await withServer(env, {}, async ({ config, agent }) => {
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
    await withServer(env, {}, async ({ config, agent }) => {
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
    await withServer(env, {}, async ({ config, agent }) => {
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
    await withServer(env, {}, async ({ config, agent }) => {
      const bytes = jpeg('upload-happy', 4000);
      const photoId = randomUUID();
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${photoId}`,
        port: config.port,
        headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes), 'Content-Length': bytes.length },
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
    await withServer(env, {}, async ({ config, agent }) => {
      for (let i = 1; i <= 2; i++) {
        const bytes = jpeg(`multi-${i}`, 3000);
        const res = await request(agent, {
          method: 'PUT',
          path: `/api/photos/5698-DELIV/${randomUUID()}`,
          port: config.port,
          headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
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
    await withServer(env, {}, async ({ config, agent }) => {
      const bytes = jpeg('part-delivery', 3000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-p2-deliv/${randomUUID()}`, // lower case, as a careless scan might produce
        port: config.port,
        headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
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
    await withServer(env, {}, async ({ config, agent }) => {
      const bytes = jpeg('bad-ref', 2000);
      for (const badRef of ['not-a-real-code', '..-DELIV', '5698-P1-DELIV']) {
        const res = await request(agent, {
          method: 'PUT',
          path: `/api/photos/${encodeURIComponent(badRef)}/${randomUUID()}`,
          port: config.port,
          headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
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
    await withServer(env, {}, async ({ config, agent }) => {
      const bytes = jpeg('bad-id', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: '/api/photos/5698-DELIV/not-a-uuid',
        port: config.port,
        headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
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
    await withServer(env, {}, async ({ config, agent }) => {
      const bytes = jpeg('no-checksum', 2000);
      for (const bad of [{}, { 'X-Photo-Sha256': 'not-hex' }, { 'X-Photo-Sha256': 'abcd' }]) {
        const res = await request(agent, { method: 'PUT', path: `/api/photos/5698-DELIV/${randomUUID()}`, port: config.port, headers: { 'Content-Type': 'image/jpeg', ...bad }, body: bytes });
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
    await withServer(env, {}, async ({ config, agent }) => {
      const bytes = jpeg('mismatch', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(Buffer.from('something else entirely')) },
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
    await withServer(env, {}, async ({ config, agent }) => {
      const bytes = Buffer.from('this is not a real jpeg file, just plain text padded out'.repeat(5));
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
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
    await withServer(env, {}, async ({ config, agent }) => {
      const bytes = jpeg('wrong-type', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Photo-Sha256': sha256(bytes) },
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
    await withServer(env, { config: { maxPhotoBytes: 500000 } }, async ({ config, agent }) => {
      // Declares a 900 KB body (as a real browser honestly would for a File/Blob
      // this size) but only ever WRITES a small fragment of it - proving the
      // refusal comes from the header alone, since the real bytes never arrive.
      const response = await new Promise((resolve, reject) => {
        const req = https.request(
          { agent, host: 'localhost', port: config.port, method: 'PUT', path: `/api/photos/5698-DELIV/${randomUUID()}`, headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(jpeg('too-big-declared', 900000)), 'Content-Length': 900000 } },
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
    await withServer(env, { config: { photoRoot: nodePath.join(env.share, 'does-not-exist') } }, async ({ config, agent }) => {
      const bytes = jpeg('no-drive', 2000);
      const res = await request(agent, {
        method: 'PUT',
        path: `/api/photos/5698-DELIV/${randomUUID()}`,
        port: config.port,
        headers: { 'Content-Type': 'image/jpeg', 'X-Photo-Sha256': sha256(bytes) },
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
    await withServer(env, {}, async ({ config, agent }) => {
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
    await withServer(env, {}, async ({ config, agent }) => {
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

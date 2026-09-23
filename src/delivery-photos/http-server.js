'use strict';

// The local server the iPad talks to. Two listeners:
//   - HTTPS (the configured port): the camera tool itself and the photo
//     upload API. A secure context is required for getUserMedia at all, so
//     everything that matters runs here.
//   - Plain HTTP (port + 1), ONLY for the one-time trust-profile bootstrap
//     (see certs.js) - before an iPad has installed and trusted the local CA,
//     it cannot open an HTTPS page at all, so that one download has to be
//     reachable over plain HTTP. It serves nothing else, and never handles a
//     photograph.
//
// Nothing here ever reaches the internet: both listeners only ever accept
// connections from the workshop network, and this file makes no outbound
// requests of its own at all.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const nodePath = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const { parse: parseReference } = require('./reference');
const { buildTrustProfileMobileConfig } = require('./certs');

const STATIC_ROOT = nodePath.join(__dirname, '..', '..', 'delivery-photos-web');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

// `closeAfter: true` marks a response sent WITHOUT the request body having
// been fully read (an early refusal, e.g. a Content-Length pre-check) - the
// connection cannot safely be reused for a next request in that case (the
// unread remainder of this request's body would be misread as the start of
// the next one), so it is explicitly closed rather than left keep-alive.
function sendJson(res, status, body, { closeAfter = false } = {}) {
  const text = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' };
  if (closeAfter) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(text);
  if (closeAfter) res.socket?.end();
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Reads the request body up to `maxBytes`. Rejects (without buffering
// further) the moment the limit is crossed, rather than after accepting an
// unbounded upload - protects the spool disk from a runaway or hostile client.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error(`Photograph is larger than the ${Math.round(maxBytes / 1000000)} MB limit.`), { code: 'too_large' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStaticFile(req, res, urlPath) {
  const relative = urlPath === '/' ? '/index.html' : urlPath;
  // decodeURIComponent + a resolved-inside-root check: this is the ONLY
  // static file server in the program, and static file paths are a classic
  // traversal target, so it gets the same "must resolve inside the root"
  // discipline as the photograph archive does.
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const resolved = nodePath.join(STATIC_ROOT, decoded);
  if (!resolved.startsWith(STATIC_ROOT + nodePath.sep) && resolved !== STATIC_ROOT) {
    res.writeHead(400).end('Bad request');
    return;
  }

  try {
    const data = await fsp.readFile(resolved);
    const ext = nodePath.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') res.writeHead(404).end('Not found');
    else res.writeHead(500).end('Server error');
  }
}

// One photograph, start to finish: validate the reference and the id, check
// the declared size/checksum headers are well-formed, read the body (capped),
// verify what actually arrived matches what was declared, spool it to a local
// temp file, hand it to the archive worker, and answer only once the file has
// genuinely been read back off the drive and matched. Never buffers an
// over-limit upload, never writes to the drive on a checksum mismatch, and
// the spool file is always removed afterwards, success or failure.
async function handleUpload(req, res, params, deps) {
  const { config, runWorker, logger, spoolDir, allowDriveLetter, testMode } = deps;

  const parsed = parseReference(params.reference);
  if (!parsed.ok) return sendJson(res, 400, { error: 'invalid_reference', message: parsed.reason });
  if (!UUID_PATTERN.test(params.photoId)) return sendJson(res, 400, { error: 'invalid_id', message: 'The photograph id must be a UUID.' });

  const declaredSha = String(req.headers['x-photo-sha256'] || '').toLowerCase();
  if (!SHA256_PATTERN.test(declaredSha)) return sendJson(res, 400, { error: 'invalid_checksum_header', message: 'Missing or malformed X-Photo-Sha256 header.' });

  const contentType = String(req.headers['content-type'] || '');
  if (!/^image\/jpe?g$/.test(contentType)) return sendJson(res, 400, { error: 'invalid_content_type', message: 'Only image/jpeg is accepted.' });

  // A well-behaved client (every real browser included) sends an honest
  // Content-Length for a Blob/File body - checking it BEFORE reading lets an
  // oversized upload be refused with a clean response and no data transfer
  // at all, rather than the abrupt mid-stream disconnect the safety-net
  // check inside readBody() below has to fall back to for a client that
  // omits it or streams without one (chunked transfer-encoding, say).
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > config.maxPhotoBytes) {
    return sendJson(res, 413, { error: 'too_large', message: `Photograph is larger than the ${Math.round(config.maxPhotoBytes / 1000000)} MB limit.` }, { closeAfter: true });
  }

  let bytes;
  try {
    bytes = await readBody(req, config.maxPhotoBytes);
  } catch (err) {
    return sendJson(res, err.code === 'too_large' ? 413 : 400, { error: err.code || 'bad_body', message: err.message });
  }
  if (bytes.length < 100) return sendJson(res, 400, { error: 'too_small', message: 'That does not look like a real photograph.' });
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return sendJson(res, 400, { error: 'not_a_jpeg', message: 'That does not look like a JPEG file (wrong signature).' });

  const actualSha = sha256Hex(bytes);
  if (actualSha !== declaredSha) return sendJson(res, 409, { error: 'checksum_mismatch', message: 'What arrived does not match the checksum the iPad declared - please retry.' });

  await fsp.mkdir(spoolDir, { recursive: true });
  const spoolPath = nodePath.join(spoolDir, `${params.photoId}.jpg`);
  // Cleanup is awaited BEFORE the response is sent (not in a finally block
  // racing against res.end() below) so a caller can rely on: by the time the
  // response arrives, the spool is already clean - never a window where the
  // client has moved on but a temp file is still briefly on disk.
  let outcome;
  try {
    await fsp.writeFile(spoolPath, bytes);

    const filed = await runWorker(
      'archive',
      { root: config.photoRoot, reference: parsed.reference, photoId: params.photoId, spoolPath, sizeBytes: bytes.length, sha256: actualSha, allowDriveLetter },
      { timeoutMs: config.operationTimeoutSeconds * 1000, testMode }
    );
    logger.info(`Filed ${filed.storagePath} (${filed.sizeBytes} bytes)${filed.adopted ? ' - already on the drive' : ''}.`);
    outcome = { status: 201, body: { ok: true, storagePath: filed.storagePath, sizeBytes: filed.sizeBytes, sha256: filed.sha256 } };
  } catch (err) {
    const message = (err && err.message) || String(err);
    logger.error(`Could not file ${params.photoId} for ${parsed.reference}: ${message}`);
    outcome = { status: 502, body: { error: 'archive_failed', message: 'The network drive could not be reached or the write could not be verified - please retry.', retryable: true } };
  } finally {
    await fsp.rm(spoolPath, { force: true }).catch(() => {});
  }
  return sendJson(res, outcome.status, outcome.body);
}

function router(req, res, deps) {
  const url = new URL(req.url, 'http://localhost');
  const match = /^\/api\/photos\/([^/]+)\/([^/]+)$/.exec(url.pathname);

  if (req.method === 'PUT' && match) {
    handleUpload(req, res, { reference: match[1], photoId: match[2] }, deps).catch((err) => {
      deps.logger.error(`Unexpected error handling an upload: ${err && err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Something went wrong. Please retry.', retryable: true });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, hostname: deps.config.hostname });
  }

  // reference.js is deliberately ONE file, shared by this server and the iPad
  // web app (see its own header comment) - canonically part of the server
  // code, not duplicated into the static web root, so the two sides can never
  // quietly drift apart. This is the one exception to STATIC_ROOT below.
  if (req.method === 'GET' && url.pathname === '/reference.js') {
    const data = fs.readFileSync(nodePath.join(__dirname, 'reference.js'));
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.js'], 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
    return;
  }

  if (req.method === 'GET') {
    serveStaticFile(req, res, url.pathname).catch(() => res.writeHead(500).end('Server error'));
    return;
  }

  res.writeHead(405).end('Method not allowed');
}

// Starts both listeners. Returns { httpsServer, httpServer, close() }.
function startServers({ config, credentials, runWorker, logger, spoolDir, allowDriveLetter, testMode }) {
  const deps = { config, runWorker, logger, spoolDir, allowDriveLetter, testMode };

  const httpsServer = https.createServer({ key: credentials.key, cert: credentials.cert }, (req, res) => router(req, res, deps));

  // The plain-HTTP bootstrap listener answers exactly one useful path - the
  // trust profile - and politely redirects everything else to the real
  // HTTPS address rather than serving the app insecurely.
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/trust.mobileconfig') {
      const body = buildTrustProfileMobileConfig(credentials.caCert);
      res.writeHead(200, {
        'Content-Type': 'application/x-apple-aspen-config',
        'Content-Disposition': 'attachment; filename="door-tracker-local-trust.mobileconfig"',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
      });
      res.end(body);
      return;
    }
    res.writeHead(302, { Location: `https://${config.hostname}:${config.port}/` });
    res.end();
  });

  return {
    httpsServer,
    httpServer,
    async listen() {
      await new Promise((resolve, reject) => {
        httpsServer.once('error', reject);
        httpsServer.listen(config.port, resolve);
      });
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port + 1, resolve);
      });
    },
    async close() {
      await Promise.all([
        new Promise((resolve) => httpsServer.close(resolve)),
        new Promise((resolve) => httpServer.close(resolve))
      ]);
    }
  };
}

module.exports = { startServers, sha256Hex, UUID_PATTERN, SHA256_PATTERN };

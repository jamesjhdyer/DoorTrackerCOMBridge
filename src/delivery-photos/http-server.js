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

const PhotoRoles = require('./photo-roles');
const { KeyedMutex } = require('./concurrency');
const { buildTrustProfileMobileConfig } = require('./certs');
const { createTrackingEvent, TrackingError } = require('./tracking');
const { recordFiledSession } = require('./filed-today');
const { serviceWorkerSource } = require('./web-shell');

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
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

// `closeAfter: true` marks a response sent WITHOUT the request body having
// been fully read (an early refusal, e.g. a Content-Length pre-check) - the
// connection cannot safely be reused for a next request in that case (the
// unread remainder of this request's body would be misread as the start of
// the next one), so it is explicitly closed rather than left keep-alive.
function sendJson(res, status, body, { closeAfter = false, headers: extraHeaders } = {}) {
  const text = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...extraHeaders };
  if (closeAfter) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(text);
  if (closeAfter) res.socket?.end();
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// The LAN address of whoever made this request - for logging/audit only,
// never for an access decision (that is entirely the pairing token's job;
// an IP on a shared/NAT'd network is not a reliable identity). Strips the
// IPv4-mapped IPv6 prefix Node reports for an IPv4 peer (`::ffff:10.0.0.5`)
// so log lines read as a plain, familiar LAN address.
function clientIp(req) {
  const raw = req.socket && req.socket.remoteAddress;
  if (!raw) return 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

// `Authorization: Bearer <token>` only - never a query string or URL
// segment, so the token can never end up in a server access log, browser
// history, or a bookmarked link.
function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1].trim() : '';
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

// The files the iPad page shares verbatim with this server (see each file's
// own header comment) - canonically part of the server code, not copies in
// the static web root, so the two sides can never quietly drift apart.
const SHARED_SCRIPTS = {
  '/reference.js': nodePath.join(__dirname, 'reference.js'),
  '/photo-roles.js': nodePath.join(__dirname, 'photo-roles.js')
};

function roleLabel(role) {
  return PhotoRoles.ROLES[role].label;
}

// The iPad MAY say which role it believes it is (X-Photo-Role) - purely so a
// photo queued on the iPad under one role and sent after the iPad was
// re-paired as another gets a clear "wrong role" answer instead of a
// confusing "not a valid code". It is only ever compared, never used: the
// role acted on always comes from the pairing token (pairing.verify()).
function claimedRoleMismatch(req, role) {
  const claimed = req.headers['x-photo-role'];
  if (claimed === undefined) return '';
  if (String(claimed) === role) return '';
  const claimedLabel = PhotoRoles.isRole(String(claimed)) ? roleLabel(String(claimed)) : 'another role';
  return `These photographs were taken as ${claimedLabel} photos, but this iPad is now paired for ${roleLabel(role)} photos. Pair it as ${claimedLabel} again to send them, or discard them.`;
}

function invalidCodeMessage(role, reason) {
  return `This iPad is paired for ${roleLabel(role)} photos and only accepts codes like ${PhotoRoles.ROLES[role].example}. ${reason}`;
}

// One photograph, start to finish: check pairing (which also fixes the
// photo role - Delivery, Bench or Ironmongery), check the server isn't
// already at capacity, parse the scanned code with THAT role's grammar to
// get the base order, validate the id, check the
// declared size/checksum headers are well-formed, read the body (capped),
// verify what actually arrived matches what was declared, spool it to a local
// temp file, hand it to the archive worker, and answer only once the file has
// genuinely been read back off the drive and matched. Never buffers an
// over-limit upload, never writes to the drive on a checksum mismatch, and
// the spool file is always removed afterwards, success or failure.
async function handleUpload(req, res, params, deps) {
  const { config, runWorker, logger, spoolDir, testMode, pairing, limiter, orderLocks } = deps;
  const ip = clientIp(req);

  const auth = pairing.verify(bearerToken(req));
  if (!auth.ok) {
    logger.warn(`Rejected an upload from ${ip}: not a paired device.`);
    return sendJson(res, 401, { error: 'unauthorized', message: 'This device is not paired. Open the Delivery Photos page on this iPad and pair it again.', retryable: false }, { closeAfter: true });
  }
  const role = auth.role;

  const mismatch = claimedRoleMismatch(req, role);
  if (mismatch) {
    logger.warn(`Rejected an upload from ${ip}: device ${auth.deviceId} is paired as ${role} but the photo was taken as ${String(req.headers['x-photo-role']).slice(0, 20)}.`);
    return sendJson(res, 403, { error: 'role_mismatch', message: mismatch, retryable: false }, { closeAfter: true });
  }

  // The scanned code, parsed with the grammar of the role this TOKEN was
  // paired as. The grammars are disjoint (see photo-roles.js), so a Bench
  // iPad can never file a delivery code, an Ironmongery iPad can never
  // produce a -DELIV file, and so on.
  const parsed = PhotoRoles.parseForRole(role, params.code);
  if (!parsed.ok) {
    logger.warn(`Rejected an upload from ${ip}: ${JSON.stringify(String(params.code).slice(0, 50))} is not a valid ${role} code.`);
    return sendJson(res, 400, { error: 'invalid_code', message: invalidCodeMessage(role, parsed.reason), retryable: false }, { closeAfter: true });
  }
  const photoRole = PhotoRoles.ROLES[role].suffix;
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

  // Capacity is reserved HERE, before the (potentially large) body is even
  // read - an over-limit request is rejected immediately rather than first
  // being allowed to buffer its body for nothing. Reference/id/header shape
  // are deliberately checked above this line instead of below it: a
  // malformed request should never cost a concurrency slot at all.
  const slot = await limiter.acquire();
  if (!slot.ok) {
    logger.warn(`Rejected an upload for ${parsed.code} from ${ip}: server busy (${slot.reason}).`);
    return sendJson(res, 429, { error: 'busy', message: 'The Delivery Photos service is busy right now - please wait a few seconds and retry.', retryable: true }, { closeAfter: true, headers: { 'Retry-After': '3' } });
  }

  try {
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
    // Unique per REQUEST, not just per photo: the same photo retried twice
    // at once must never share (and then delete) one spool file.
    const spoolPath = nodePath.join(spoolDir, `${params.photoId}-${randomUUID()}.jpg`);
    // Cleanup is awaited BEFORE the response is sent (not in a finally block
    // racing against res.end() below) so a caller can rely on: by the time the
    // response arrives, the spool is already clean - never a window where the
    // client has moved on but a temp file is still briefly on disk.
    let outcome;
    try {
      await fsp.writeFile(spoolPath, bytes);

      // Folder and file name are decided entirely in the archive worker,
      // from the base order and the role suffix - and one save per order
      // folder at a time (orderLocks), so the next sequence number is
      // always chosen with the previous save already on the drive.
      const filed = await orderLocks.run(parsed.baseOrder, () =>
        runWorker(
          'archive',
          { root: config.photoRoot, baseOrder: parsed.baseOrder, photoRole, photoId: params.photoId, spoolPath, sizeBytes: bytes.length, sha256: actualSha, minFreeGb: config.minFreeGb },
          { timeoutMs: config.operationTimeoutSeconds * 1000, testMode }
        )
      );
      logger.info(`Filed ${filed.storagePath} (${filed.sizeBytes} bytes, ${role}, scanned ${parsed.code})${filed.adopted ? ' - already on the drive' : ''}, from ${ip}.`);
      outcome = { status: 201, body: { ok: true, role, baseOrder: parsed.baseOrder, storagePath: filed.storagePath, sizeBytes: filed.sizeBytes, sha256: filed.sha256 } };
    } catch (err) {
      const message = (err && err.message) || String(err);
      logger.error(`Could not file ${params.photoId} for ${parsed.code} (${role}) from ${ip}: ${message}`);
      if (err && err.code === 'INSUFFICIENT_SPACE') {
        outcome = { status: 507, body: { error: 'insufficient_storage', message: 'There is not enough free space on the archive drive right now. Please tell the office and try again later.', retryable: true } };
      } else {
        outcome = { status: 502, body: { error: 'archive_failed', message: 'The network drive could not be reached or the write could not be verified - please retry.', retryable: true } };
      }
    } finally {
      await fsp.rm(spoolPath, { force: true }).catch(() => {});
    }
    return sendJson(res, outcome.status, outcome.body);
  } finally {
    slot.release();
  }
}

// POST /api/pair { code } -> { token, deviceId, role, name }. No auth required - this
// IS the auth bootstrap - but gated by the pairing code's own short expiry,
// single-use, and attempt limit (see auth.js). Never logs the code or the
// issued token, only the plain outcome and the requester's IP.
async function handlePair(req, res, deps) {
  const { pairing, logger } = deps;
  const ip = clientIp(req);

  let body;
  try {
    const raw = await readBody(req, 1000);
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return sendJson(res, 400, { error: 'bad_body', message: 'Malformed pairing request.' }, { closeAfter: true });
  }

  const result = pairing.pair(body && body.code);
  if (!result.ok) {
    const messages = {
      no_active_code: 'No pairing code is currently active. Generate one on the PC first.',
      expired: 'That pairing code has expired. Generate a new one on the PC.',
      too_many_attempts: 'Too many wrong attempts. Generate a new pairing code on the PC.',
      wrong_code: 'That code was not recognised. Check it and try again.'
    };
    logger.warn(`Pairing attempt from ${ip} failed: ${result.reason}.`);
    return sendJson(res, 401, { error: result.reason, message: messages[result.reason] || 'Could not pair this device.' }, { closeAfter: true });
  }

  // The role comes from the code generated on the PC - nothing in the
  // request body other than `code` is ever read.
  logger.info(`A new device paired from ${ip} as ${result.role} ("${result.name}").`);
  return sendJson(res, 200, { ok: true, token: result.token, deviceId: result.deviceId, role: result.role, name: result.name });
}

// GET /api/pair/check - lets the iPad app find out, on load, whether its
// already-stored token is still good (e.g. not revoked since last time)
// without needing to attempt a real photo upload just to find out.
// Also tells it which role it is paired as, so a role changed on the PC
// (removed and paired again) shows on the iPad - display only; the server
// never takes the role from the iPad.
function handlePairCheck(req, res, deps) {
  const { pairing } = deps;
  const auth = pairing.verify(bearerToken(req));
  return sendJson(res, 200, auth.ok ? { paired: true, role: auth.role, name: auth.name } : { paired: false });
}

// What happens once a whole session's photographs are confirmed saved, per
// role. Only Delivery is tracked today (the DELIVERY_PHOTO_SCANS Google
// Sheet and "Orders filed today"); Bench and Ironmongery sessions are
// logged and acknowledged but recorded nowhere else. Separate tracking for
// either later is one more entry here - it must never write into the
// Delivery sheet.
const SESSION_TRACKERS = {
  delivery: trackDeliverySession
};

// A Delivery session: one DELIVERY_PHOTO_SCANS tracking event, plus the
// "Orders filed today" ledger. The Full/Part details come from the original
// delivery scan (parsed.delivery), never from the file names on the drive.
function trackDeliverySession({ parsed, photosSaved, sessionId, ip }, deps) {
  const { logger, queueDir, filedLogDir } = deps;
  const record = createTrackingEvent({ reference: parsed.delivery.reference, photosSaved, eventId: sessionId ?? undefined }, { queueDir });
  if (record.duplicate) {
    logger.info(`Session ${record.eventId} (${record.reference}) reported complete again from ${ip} - already recorded, not duplicated.`);
    return { status: 200, body: { ok: true, eventId: record.eventId, duplicate: true } };
  }
  logger.info(`Tracking event created: ${record.eventId} (${record.reference}, ${record.photosSaved} photo${record.photosSaved === 1 ? '' : 's'}) from ${ip}.`);
  // The local "Orders filed today" ledger (see filed-today.js). A display
  // figure only - failing to write it must never fail a delivery whose
  // photographs and tracking event are already safely saved.
  try {
    recordFiledSession(filedLogDir, record);
  } catch (err) {
    logger.warn(`Could not add ${record.reference} to the filed-today ledger: ${err && err.message}`);
  }
  if (process.send) process.send({ event: 'tracking-pending', eventId: record.eventId });
  return { status: 201, body: { ok: true, eventId: record.eventId } };
}

async function readJsonBody(req, res) {
  try {
    const raw = await readBody(req, 1000);
    return JSON.parse(raw.toString('utf8') || '{}') || {};
  } catch {
    sendJson(res, 400, { error: 'bad_body', message: 'Malformed request.' }, { closeAfter: true });
    return null;
  }
}

// Shared by both session-complete routes once the device is authenticated
// and `code` is known. Called by the iPad ONLY once every photograph in the
// session already came back 201 from PUT /api/photos/... (checksum-verified,
// read back off the drive - see handleUpload). Never re-verifies that and
// never touches the archive; it exists purely to record "this whole session
// is done". Answers once the record is durably queued locally - never waits
// on the internet (see tracking.js's own header comment for why).
// `sessionId` (sent by every current iPad, online or from its offline queue)
// becomes the tracking Event ID, so reporting the same session twice - a
// retry after a lost answer - is acknowledged without a second event or a
// second Sheet row (see tracking.js's createTrackingEvent).
function completeSession({ auth, code, photosSaved, sessionId, ip }, res, deps) {
  const { logger } = deps;
  const role = auth.role;
  const parsed = PhotoRoles.parseForRole(role, code);
  if (!parsed.ok) return sendJson(res, 400, { error: 'bad_request', message: invalidCodeMessage(role, parsed.reason) });
  if (!Number.isInteger(photosSaved) || photosSaved < 1) return sendJson(res, 400, { error: 'bad_request', message: 'photosSaved must be a positive whole number' });
  if (sessionId !== undefined && sessionId !== null && !UUID_PATTERN.test(String(sessionId))) return sendJson(res, 400, { error: 'bad_request', message: 'sessionId must be a lower-case UUID' });

  const tracker = SESSION_TRACKERS[role];
  if (!tracker) {
    logger.info(`${roleLabel(role)} session ${sessionId || '(no id)'} complete: order ${parsed.baseOrder}, scanned ${parsed.code}, ${photosSaved} photo${photosSaved === 1 ? '' : 's'}, from ${ip} - not tracked in any Sheet.`);
    return sendJson(res, 201, { ok: true, role, tracked: false });
  }
  try {
    const outcome = tracker({ parsed, photosSaved, sessionId, ip }, deps);
    return sendJson(res, outcome.status, { ...outcome.body, role, tracked: true });
  } catch (err) {
    if (err instanceof TrackingError) return sendJson(res, 400, { error: 'bad_request', message: err.message });
    logger.error(`Could not record a completed ${role} session from ${ip}: ${err && err.message}`);
    return sendJson(res, 500, { error: 'internal', message: 'Could not record this session as complete.' });
  }
}

function authenticate(req, res, deps, what) {
  const auth = deps.pairing.verify(bearerToken(req));
  if (!auth.ok) {
    deps.logger.warn(`Rejected ${what} from ${clientIp(req)}: not a paired device.`);
    sendJson(res, 401, { error: 'unauthorized', message: 'This device is not paired.' }, { closeAfter: true });
    return null;
  }
  return auth;
}

// POST /api/photo-sessions/complete { sessionId, code, photosSaved } - the
// route every role uses. `code` is the original scanned value; it is parsed
// with the role of the token, exactly like an upload. Any `role` field in
// the body is ignored.
async function handlePhotoSessionComplete(req, res, deps) {
  const auth = authenticate(req, res, deps, 'a session-complete report');
  if (!auth) return;
  const mismatch = claimedRoleMismatch(req, auth.role);
  if (mismatch) return sendJson(res, 403, { error: 'role_mismatch', message: mismatch, retryable: false }, { closeAfter: true });
  const body = await readJsonBody(req, res);
  if (!body) return;
  return completeSession({ auth, code: body.code, photosSaved: Number(body.photosSaved), sessionId: body.sessionId ?? undefined, ip: clientIp(req) }, res, deps);
}

// POST /api/delivery-sessions/complete { reference, photosSaved, sessionId? } -
// the original, Delivery-only route, kept so an iPad still running the
// previous version of the page (its offline copy is refreshed the next time
// it opens on the workshop Wi-Fi) keeps working. Refused for any token that
// is not paired as Delivery.
async function handleSessionComplete(req, res, deps) {
  const auth = authenticate(req, res, deps, 'a session-complete report');
  if (!auth) return;
  if (auth.role !== 'delivery') {
    deps.logger.warn(`Rejected a delivery session-complete report from ${clientIp(req)}: device ${auth.deviceId} is paired as ${auth.role}.`);
    return sendJson(res, 403, { error: 'role_mismatch', message: `This iPad is paired for ${roleLabel(auth.role)} photos, not Delivery.`, retryable: false }, { closeAfter: true });
  }
  const body = await readJsonBody(req, res);
  if (!body) return;
  return completeSession({ auth, code: body.reference, photosSaved: Number(body.photosSaved), sessionId: body.sessionId ?? undefined, ip: clientIp(req) }, res, deps);
}

function router(req, res, deps) {
  const url = new URL(req.url, 'http://localhost');
  const match = /^\/api\/photos\/([^/]+)\/([^/]+)$/.exec(url.pathname);

  // PUT /api/photos/<scanned code>/<photo uuid> - the path names only the
  // code the iPad scanned (e.g. 5698-P2-DELIV, 5698-D-07, 5626-2) and the
  // photo's id. Never a folder or file name: those are decided server-side.
  if (req.method === 'PUT' && match) {
    handleUpload(req, res, { code: match[1], photoId: match[2] }, deps).catch((err) => {
      deps.logger.error(`Unexpected error handling an upload: ${err && err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Something went wrong. Please retry.', retryable: true });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/pair') {
    handlePair(req, res, deps).catch((err) => {
      deps.logger.error(`Unexpected error handling a pairing request: ${err && err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Something went wrong. Please retry.' });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/pair/check') {
    return handlePairCheck(req, res, deps);
  }

  if (req.method === 'POST' && url.pathname === '/api/photo-sessions/complete') {
    handlePhotoSessionComplete(req, res, deps).catch((err) => {
      deps.logger.error(`Unexpected error handling a session-complete report: ${err && err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Something went wrong.' });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/delivery-sessions/complete') {
    handleSessionComplete(req, res, deps).catch((err) => {
      deps.logger.error(`Unexpected error handling a session-complete report: ${err && err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Something went wrong.' });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, hostname: deps.config.hostname });
  }

  // reference.js and photo-roles.js are deliberately ONE file each, shared by
  // this server and the iPad web app (see SHARED_SCRIPTS) - the only
  // exceptions to STATIC_ROOT below.
  if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(SHARED_SCRIPTS, url.pathname)) {
    const data = fs.readFileSync(SHARED_SCRIPTS[url.pathname]);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.js'], 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
    return;
  }

  // The iPad's offline Service Worker, stamped with the current app shell's
  // version and file list (see web-shell.js). Served at the site root so its
  // scope covers the whole tool, and never cached by the browser's ordinary
  // HTTP cache, so a new Windows build is noticed the next time the iPad
  // opens the tool on the workshop network.
  if (req.method === 'GET' && url.pathname === '/sw.js') {
    const data = Buffer.from(serviceWorkerSource(), 'utf8');
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
// `pairing` (auth.js's PairingManager) and `limiter` (concurrency.js's
// ConcurrencyLimiter) are created once per worker instance by the caller
// (worker-entry.js) and passed in here, same as `runWorker` already is - and
// so is `orderLocks` (concurrency.js's KeyedMutex), so a settings reload can
// never let a save on the old server and one on the new server choose a
// number in the same order folder at once.
function startServers({ config, credentials, runWorker, logger, spoolDir, testMode, pairing, limiter, orderLocks = new KeyedMutex(), queueDir, filedLogDir }) {
  const deps = { config, runWorker, logger, spoolDir, testMode, pairing, limiter, orderLocks, queueDir, filedLogDir };

  const httpsServer = https.createServer({ key: credentials.key, cert: credentials.cert }, (req, res) => router(req, res, deps));
  // Explicit, intentionally generous-but-bounded request timeouts (Node's
  // own defaults are not this explicit) - a slow or stalled connection can
  // only ever hold its one concurrency slot for this long, never forever.
  // The photo upload itself has no server-side artificial delay; a real
  // photograph over the workshop's own Wi-Fi finishes in a small fraction
  // of this. Does not change any port, address, or TLS behaviour.
  httpsServer.headersTimeout = 20000;
  httpsServer.requestTimeout = 60000;

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
  httpServer.headersTimeout = 10000;
  httpServer.requestTimeout = 20000;

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

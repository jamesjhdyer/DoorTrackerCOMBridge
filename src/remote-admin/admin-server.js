'use strict';

// Remote Admin's HTTPS server: the admin page and its small JSON API. Runs in
// the Remote Admin process (admin-entry.js), never in the Electron main
// process - it only ASKS main.js to do things, through callMain(), naming one
// of a fixed list of actions (see actions.js's ACTION_NAMES). It cannot open
// a COM port, write a file, or run anything itself.
//
// Every request passes, in order:
//   1. a private/loopback/link-local TCP peer (checked on connect, before TLS)
//   2. a per-address request ceiling
//   3. a Host header naming this PC (no DNS rebinding)
//   4. for the API, a signed-in session cookie (HttpOnly, Secure,
//      SameSite=Strict, __Host- prefixed)
//   5. for anything that changes state: an Origin header matching this exact
//      address, a JSON body (so no plain HTML form can submit it), the
//      session's CSRF token in X-CSRF-Token, and a small body size limit.
// Sign-in itself is rate limited (see admin-auth.js's LoginLimiter). Every
// sign-in and every action is written to the audit log with the client's
// address and the outcome - never a password, session token or CSRF token.

const fs = require('node:fs');
const https = require('node:https');
const crypto = require('node:crypto');
const nodePath = require('node:path');

const { verifyPassword, SessionStore, LoginLimiter, RequestLimiter } = require('./admin-auth');
const { normalizeIp, isPrivateAddress, hostAllowed } = require('./net-guard');
const { readRecentLogs } = require('./log-reader');
const { ACTION_NAMES } = require('./actions');

const COOKIE_NAME = '__Host-dtadmin';
const MAX_BODY_BYTES = 8 * 1024;

const WEB_ROOT = nodePath.join(__dirname, 'web');
// The only files the page is made of - a fixed list, not a folder that is served.
const STATIC_FILES = {
  '/admin/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/admin/admin.js': { file: 'admin.js', type: 'text/javascript; charset=utf-8' },
  '/admin/admin.css': { file: 'admin.css', type: 'text/css; charset=utf-8' }
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store'
};

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function send(res, status, body, { type = 'application/json; charset=utf-8', headers = {} } = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': data.length, ...headers });
  res.end(data);
}

function sendError(res, err, closeAfter) {
  const headers = { ...err.headers };
  if (closeAfter) headers.Connection = 'close';
  send(res, err.status, { error: err.code, message: err.message }, { headers });
  if (closeAfter) res.socket?.end();
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function readJsonBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return Promise.reject(new HttpError(415, 'unsupported_media_type', 'Requests must be sent as JSON.'));
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return Promise.reject(new HttpError(413, 'too_large', 'Request is too large.'));

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        reject(new HttpError(413, 'too_large', 'Request is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total > MAX_BODY_BYTES) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'bad_body', 'Malformed request.'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'bad_body', 'Malformed request.')));
  });
}

// Short, log-safe description of an action's target for the audit line -
// ids and port names only, never free text from the request.
function auditTarget(params) {
  const p = params && typeof params === 'object' ? params : {};
  const bits = [];
  if (typeof p.tabId === 'string') bits.push(`connection=${p.tabId.slice(0, 40).replace(/[^A-Za-z0-9-]/g, '')}`);
  if (typeof p.comPort === 'string') bits.push(`port=${p.comPort.slice(0, 20).replace(/[^A-Za-z0-9/._-]/g, '')}`);
  return bits.join(' ');
}

function createAdminServer(options) {
  const {
    tls,
    port,
    getPasswordRecord,
    callMain,
    audit,
    logSources = {},
    sessions = new SessionStore(),
    loginLimiter = new LoginLimiter(),
    requestLimiter = new RequestLimiter(),
    allowedNames
  } = options;

  let caCertPem = tls.caCert;
  let verifyChain = Promise.resolve();
  const staticCache = new Map();

  function staticFile(name) {
    if (!staticCache.has(name)) staticCache.set(name, fs.readFileSync(nodePath.join(WEB_ROOT, name)));
    return staticCache.get(name);
  }

  // One scrypt at a time, so a burst of sign-in attempts queues instead of
  // using up memory and CPU in parallel.
  function verifySerialized(password, record) {
    const run = verifyChain.then(() => verifyPassword(password, record));
    verifyChain = run.catch(() => {});
    return run;
  }

  function requireSession(req) {
    const token = readCookie(req, COOKIE_NAME);
    const session = token ? sessions.get(token) : null;
    if (!session) throw new HttpError(401, 'unauthorized', 'Please sign in.');
    return { token, session };
  }

  // State-changing requests must come from this page itself: the browser's
  // Origin header names exactly the address in the Host header.
  function requireSameOrigin(req) {
    const origin = String(req.headers.origin || '').toLowerCase();
    const expected = `https://${String(req.headers.host || '').toLowerCase()}`;
    if (!origin || origin !== expected) throw new HttpError(403, 'bad_origin', 'Request refused (wrong origin).');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') throw new HttpError(403, 'bad_origin', 'Request refused (cross-site).');
  }

  function requireCsrf(req, session) {
    const presented = String(req.headers['x-csrf-token'] || '');
    if (!presented || !safeEqual(presented, session.csrfToken)) throw new HttpError(403, 'bad_csrf', 'Request refused (missing or stale security token). Reload the page.');
  }

  async function handleLogin(req, res, ip) {
    requireSameOrigin(req);
    const body = await readJsonBody(req);
    const record = getPasswordRecord();
    if (!record) throw new HttpError(503, 'not_set_up', 'No admin password has been set on the COM Bridge PC.');

    const gate = loginLimiter.check(ip);
    if (!gate.ok) {
      audit.warn(`AUDIT ip=${ip} action=login result=blocked reason=too_many_failures`);
      throw new HttpError(429, 'too_many_attempts', `Too many failed sign-in attempts. Try again in ${Math.ceil(gate.retryAfterSeconds / 60)} minute(s).`, { 'Retry-After': String(gate.retryAfterSeconds) });
    }

    const ok = await verifySerialized(typeof body.password === 'string' ? body.password : '', record);
    if (!ok) {
      loginLimiter.recordFailure(ip);
      audit.warn(`AUDIT ip=${ip} action=login result=failure reason=wrong_password`);
      throw new HttpError(401, 'wrong_password', 'That password is not correct.');
    }

    loginLimiter.recordSuccess(ip);
    const created = sessions.create(ip);
    audit.info(`AUDIT ip=${ip} action=login result=success`);
    send(res, 200, { ok: true, csrfToken: created.csrfToken }, {
      headers: { 'Set-Cookie': `${COOKIE_NAME}=${created.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${created.maxAgeSeconds}` }
    });
  }

  async function handleLogout(req, res, ip) {
    requireSameOrigin(req);
    const { token, session } = requireSession(req);
    requireCsrf(req, session);
    sessions.destroy(token);
    audit.info(`AUDIT ip=${ip} action=logout result=success`);
    send(res, 200, { ok: true }, { headers: { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` } });
  }

  async function forward(action, params, meta) {
    let reply;
    try {
      reply = await callMain(action, params, meta);
    } catch (err) {
      throw new HttpError(504, 'unavailable', (err && err.message) || 'The COM Bridge did not answer.');
    }
    if (!reply || !reply.ok) {
      const status = reply && reply.error === 'confirmation_required' ? 409 : 400;
      return { status, body: { error: (reply && reply.error) || 'failed', message: (reply && reply.message) || 'The action failed.', errors: reply && reply.errors } };
    }
    return { status: 200, body: { ok: true, result: reply.result } };
  }

  async function handleAction(req, res, ip) {
    requireSameOrigin(req);
    const { session } = requireSession(req);
    requireCsrf(req, session);
    const body = await readJsonBody(req);
    const action = typeof body.action === 'string' ? body.action : '';
    if (!ACTION_NAMES.includes(action) || action === 'get-state' || action === 'list-ports') {
      throw new HttpError(400, 'unknown_action', 'Unknown action.');
    }
    const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
    const outcome = await forward(action, { ...params, confirm: body.confirm === true }, { ip });
    const result = outcome.status === 200 ? 'success' : 'failure';
    const summary = outcome.body.result && typeof outcome.body.result.audit === 'string' ? ` ${outcome.body.result.audit}` : '';
    const reason = outcome.status === 200 ? '' : ` reason=${outcome.body.error}`;
    (outcome.status === 200 ? audit.info : audit.warn)(`AUDIT ip=${ip} action=${action} ${auditTarget(params)}${summary} result=${result}${reason}`.replace(/\s+/g, ' '));
    send(res, outcome.status, outcome.body);
  }

  async function route(req, res, ip, url) {
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && (path === '/' || path === '/admin')) {
      return send(res, 302, '', { type: 'text/plain; charset=utf-8', headers: { Location: '/admin/' } });
    }
    if (Object.prototype.hasOwnProperty.call(STATIC_FILES, path)) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      const { file, type } = STATIC_FILES[path];
      return send(res, 200, staticFile(file), { type });
    }
    if (path === '/admin/ca.crt') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      return send(res, 200, caCertPem, { type: 'application/x-x509-ca-cert', headers: { 'Content-Disposition': 'attachment; filename="door-tracker-remote-admin-ca.crt"' } });
    }

    const api = {
      'GET /admin/api/session': () => {
        const token = readCookie(req, COOKIE_NAME);
        const session = token ? sessions.get(token) : null;
        send(res, 200, session ? { authenticated: true, csrfToken: session.csrfToken } : { authenticated: false, passwordSet: Boolean(getPasswordRecord()) });
      },
      'POST /admin/api/login': () => handleLogin(req, res, ip),
      'POST /admin/api/logout': () => handleLogout(req, res, ip),
      'GET /admin/api/state': async () => {
        requireSession(req);
        const outcome = await forward('get-state', {}, { ip });
        send(res, outcome.status, outcome.body);
      },
      'GET /admin/api/ports': async () => {
        requireSession(req);
        const outcome = await forward('list-ports', {}, { ip });
        send(res, outcome.status, outcome.body);
      },
      'GET /admin/api/logs': () => {
        requireSession(req);
        const limit = Number(url.searchParams.get('limit') || 100);
        const entries = readRecentLogs(logSources, String(url.searchParams.get('source') || ''), Number.isInteger(limit) ? limit : 100);
        if (entries === null) throw new HttpError(400, 'unknown_source', 'Unknown log.');
        send(res, 200, { ok: true, entries });
      },
      'POST /admin/api/action': () => handleAction(req, res, ip)
    };

    const handler = api[`${method} ${path}`];
    if (handler) return handler();
    if (Object.keys(api).some((key) => key.endsWith(` ${path}`))) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    throw new HttpError(404, 'not_found', 'Not found.');
  }

  function onRequest(req, res) {
    const ip = normalizeIp(req.socket.remoteAddress);
    if (!isPrivateAddress(ip)) {
      req.socket.destroy();
      return;
    }
    if (!requestLimiter.allow(ip)) {
      return sendError(res, new HttpError(429, 'rate_limited', 'Too many requests - slow down.', { 'Retry-After': '30' }), true);
    }
    if (!hostAllowed(req.headers.host, port, allowedNames ? allowedNames() : undefined)) {
      return sendError(res, new HttpError(421, 'wrong_host', 'This address is not served here.'), true);
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      return sendError(res, new HttpError(405, 'method_not_allowed', 'Method not allowed.'), true);
    }

    let url;
    try {
      url = new URL(req.url, 'https://admin.invalid');
    } catch {
      return sendError(res, new HttpError(400, 'bad_request', 'Malformed request.'), true);
    }

    route(req, res, ip, url).catch((err) => {
      if (res.headersSent) return;
      // A request refused before its body was read cannot leave the
      // connection open: the unread body would be taken as the next request.
      if (err instanceof HttpError) return sendError(res, err, !req.complete);
      audit.error(`Unexpected error handling ${req.method} ${String(req.url).split('?')[0].slice(0, 80)}: ${err && err.message}`);
      sendError(res, new HttpError(500, 'internal', 'Something went wrong.'));
    });
  }

  const server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, onRequest);
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.maxConnections = 64;
  // Refused before the TLS handshake even starts - see net-guard.js.
  server.on('connection', (socket) => {
    if (!isPrivateAddress(socket.remoteAddress)) socket.destroy();
  });
  server.on('tlsClientError', () => {});

  return {
    server,
    sessions,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    // A new certificate (e.g. this PC's IP address changed) without dropping the listener.
    setCredentials(next) {
      server.setSecureContext({ key: next.key, cert: next.cert });
      caCertPem = next.caCert;
    },
    revokeSessions() {
      sessions.clear();
    }
  };
}

module.exports = { createAdminServer, COOKIE_NAME, MAX_BODY_BYTES, STATIC_FILES };

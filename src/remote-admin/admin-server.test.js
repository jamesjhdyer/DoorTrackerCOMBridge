'use strict';

// Real HTTPS requests against the real admin server (a real generated
// certificate, actually trusted by the test client), with callMain() faked so
// no Electron or serial port is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');
const nodePath = require('node:path');

const { createAdminServer, COOKIE_NAME } = require('./admin-server');
const { ensureAdminCertificates } = require('./admin-certs');
const { hashPassword, SessionStore, LoginLimiter } = require('./admin-auth');
const { PairingManager } = require('../delivery-photos/auth');

const PASSWORD = 'correct horse 42';
const certDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'ra-server-certs-'));
const tls = ensureAdminCertificates(certDir, { primary: 'localhost', extra: [] });
const passwordRecord = hashPassword(PASSWORD);

test.after(() => fs.rmSync(certDir, { recursive: true, force: true }));

// Deterministic, never-reused ports (see http-server.test.js for why random
// ones are avoided with Node's TLS session cache).
let nextPort = 9700;

function auditLog() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level} ${message}`);
  return { info: push('INFO'), warn: push('WARN'), error: push('ERROR'), lines };
}

async function withServer(overrides, fn) {
  const port = nextPort++;
  const record = await passwordRecord;
  const calls = [];
  const audit = auditLog();
  const handle = createAdminServer({
    tls,
    port,
    getPasswordRecord: () => record,
    callMain: overrides.callMain || (async (action, params) => {
      calls.push([action, params]);
      return { ok: true, result: { action, audit: 'COM5 (Door Cut)' } };
    }),
    audit,
    logSources: overrides.logSources || {},
    sessions: overrides.sessions,
    loginLimiter: overrides.loginLimiter,
    allowedNames: () => new Set(['localhost', '127.0.0.1'])
  });
  await handle.listen();
  try {
    await fn({ port, calls, audit, handle });
  } finally {
    await handle.close();
  }
}

function request(port, { method = 'GET', path = '/', headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
    const allHeaders = { Host: `localhost:${port}`, ...headers };
    if (method === 'POST') {
      if (!('Origin' in allHeaders)) allHeaders.Origin = `https://localhost:${port}`;
      if (!('Content-Type' in allHeaders)) allHeaders['Content-Type'] = 'application/json';
    }
    for (const [key, value] of Object.entries(allHeaders)) if (value === undefined) delete allHeaders[key];
    if (payload !== undefined) allHeaders['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({ host: '127.0.0.1', port, method, path, headers: allHeaders, ca: tls.caCert, servername: 'localhost', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function login(port, password = PASSWORD) {
  const res = await request(port, { method: 'POST', path: '/admin/api/login', body: { password } });
  const setCookie = (res.headers['set-cookie'] || [])[0] || '';
  const cookie = setCookie.split(';')[0];
  return { res, cookie, csrf: res.json && res.json.csrfToken, setCookie };
}

function authed(session, extra = {}) {
  return { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, ...extra };
}

test('the page itself loads without signing in, with strict security headers; the API does not', async () => {
  await withServer({}, async ({ port, calls }) => {
    const page = await request(port, { path: '/admin/' });
    assert.equal(page.status, 200);
    assert.match(page.text, /Remote Admin/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['cache-control'], 'no-store');

    for (const path of ['/admin/api/state', '/admin/api/ports', '/admin/api/logs?source=com-bridge']) {
      const res = await request(port, { path });
      assert.equal(res.status, 401, path);
    }
    const action = await request(port, { method: 'POST', path: '/admin/api/action', body: { action: 'connect', params: { tabId: 'tab-a' } } });
    assert.equal(action.status, 401);
    assert.deepEqual(calls, [], 'nothing reached the COM Bridge');
  });
});

test('a correct password signs in with a secure session cookie, and the session can then read state', async () => {
  await withServer({}, async ({ port, calls, audit }) => {
    const session = await login(port);
    assert.equal(session.res.status, 200);
    assert.ok(session.csrf);
    assert.match(session.setCookie, new RegExp(`^${COOKIE_NAME}=`));
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(session.setCookie.includes(flag), flag);

    const state = await request(port, { path: '/admin/api/state', headers: { Cookie: session.cookie } });
    assert.equal(state.status, 200);
    assert.deepEqual(calls, [['get-state', {}]]);
    assert.ok(audit.lines.some((l) => /action=login result=success/.test(l) && /ip=127\.0\.0\.1/.test(l)));
  });
});

test('a wrong password is refused, and after 5 failures even the right one is rate-limited', async () => {
  await withServer({}, async ({ port, audit }) => {
    for (let i = 0; i < 5; i++) {
      const wrong = await login(port, `wrong password ${i}`);
      assert.equal(wrong.res.status, 401);
      assert.equal(wrong.cookie, '');
    }
    const blocked = await login(port);
    assert.equal(blocked.res.status, 429);
    assert.ok(Number(blocked.res.headers['retry-after']) > 0);
    assert.equal(blocked.cookie, '', 'no session while blocked');
    assert.ok(audit.lines.some((l) => /action=login result=blocked/.test(l)));
    assert.equal(audit.lines.filter((l) => /result=failure/.test(l)).length, 5);
  });
});

test('an expired session is rejected, and so is a signed-out one', async () => {
  let now = Date.now();
  const sessions = new SessionStore({ idleMs: 60000, absoluteMs: 600000, now: () => now });
  await withServer({ sessions }, async ({ port }) => {
    const session = await login(port);
    assert.equal((await request(port, { path: '/admin/api/state', headers: { Cookie: session.cookie } })).status, 200);
    now += 60001;
    assert.equal((await request(port, { path: '/admin/api/state', headers: { Cookie: session.cookie } })).status, 401);

    const second = await login(port);
    const out = await request(port, { method: 'POST', path: '/admin/api/logout', headers: authed(second), body: {} });
    assert.equal(out.status, 200);
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal((await request(port, { path: '/admin/api/state', headers: { Cookie: second.cookie } })).status, 401);
  });
});

test('state-changing requests need the CSRF token and a same-origin Origin header', async () => {
  await withServer({}, async ({ port, calls }) => {
    const session = await login(port);
    const body = { action: 'connect', params: { tabId: 'tab-a' } };

    const noCsrf = await request(port, { method: 'POST', path: '/admin/api/action', headers: { Cookie: session.cookie }, body });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.error, 'bad_csrf');

    const wrongCsrf = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session, { 'X-CSRF-Token': 'x'.repeat(43) }), body });
    assert.equal(wrongCsrf.status, 403);

    const evilOrigin = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session, { Origin: 'https://evil.example.com' }), body });
    assert.equal(evilOrigin.status, 403);
    assert.equal(evilOrigin.json.error, 'bad_origin');

    const noOrigin = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session, { Origin: undefined }), body });
    assert.equal(noOrigin.status, 403);

    const crossSite = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session, { 'Sec-Fetch-Site': 'cross-site' }), body });
    assert.equal(crossSite.status, 403);

    const loginCsrf = await request(port, { method: 'POST', path: '/admin/api/login', headers: { Origin: 'https://evil.example.com' }, body: { password: PASSWORD } });
    assert.equal(loginCsrf.status, 403, 'sign-in from another site is refused too');

    assert.deepEqual(calls, []);
    const ok = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session), body });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, [['connect', { tabId: 'tab-a', confirm: false }]]);
  });
});

test('a Host header naming some other site (DNS rebinding) is refused', async () => {
  await withServer({}, async ({ port }) => {
    for (const host of ['evil.example.com', `evil.example.com:${port}`, `localhost:${port + 1}`]) {
      const res = await request(port, { path: '/admin/', headers: { Host: host } });
      assert.equal(res.status, 421, host);
    }
  });
});

test('malformed, oversized and non-JSON requests are refused before reaching the COM Bridge', async () => {
  await withServer({}, async ({ port, calls }) => {
    const session = await login(port);
    const notJson = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session, { 'Content-Type': 'text/plain' }), rawBody: 'action=connect' });
    assert.equal(notJson.status, 415);

    const form = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session, { 'Content-Type': 'application/x-www-form-urlencoded' }), rawBody: 'action=connect' });
    assert.equal(form.status, 415);

    const broken = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session), rawBody: '{"action": ' });
    assert.equal(broken.status, 400);

    const array = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session), rawBody: '[1,2]' });
    assert.equal(array.status, 400);

    const huge = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session), body: { action: 'connect', params: { tabId: 'x'.repeat(20000) } } });
    assert.equal(huge.status, 413);

    const unknown = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session), body: { action: 'exec', params: { cmd: 'shutdown /s' } } });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error, 'unknown_action');

    const put = await request(port, { method: 'PUT', path: '/admin/api/action', headers: authed(session) });
    assert.equal(put.status, 405);

    const traversal = await request(port, { path: '/admin/../../etc/passwd' });
    assert.equal(traversal.status, 404);

    assert.deepEqual(calls, []);
  });
});

test('an iPad\'s Delivery Photos pairing token never grants admin access', async () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'ra-pairing-'));
  try {
    const pairing = new PairingManager({ devicesPath: nodePath.join(dir, 'paired-devices.json') });
    const { token } = pairing.pair(pairing.generateCode({ role: 'delivery' }).code);
    assert.equal(pairing.verify(token).ok, true, 'a genuinely valid iPad token');

    await withServer({}, async ({ port, calls }) => {
      for (const headers of [{ Authorization: `Bearer ${token}` }, { Cookie: `${COOKIE_NAME}=${token}` }]) {
        assert.equal((await request(port, { path: '/admin/api/state', headers })).status, 401);
        assert.equal((await request(port, { method: 'POST', path: '/admin/api/action', headers: { ...headers, 'X-CSRF-Token': token }, body: { action: 'connect', params: { tabId: 'tab-a' } } })).status, 401);
      }
      assert.equal((await login(port, token)).res.status, 401, 'nor as the admin password');
      assert.deepEqual(calls, []);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a confirmation request from the COM Bridge comes back as 409 with its message, and is audited', async () => {
  const callMain = async (action, params) => (params.confirm ? { ok: true, result: { audit: 'COM5 (Door Cut)' } } : { ok: false, error: 'confirmation_required', message: 'Disconnect COM5 (Door Cut)?' });
  await withServer({ callMain }, async ({ port, audit }) => {
    const session = await login(port);
    const first = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session), body: { action: 'disconnect', params: { tabId: 'tab-a' } } });
    assert.equal(first.status, 409);
    assert.equal(first.json.message, 'Disconnect COM5 (Door Cut)?');
    const second = await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session), body: { action: 'disconnect', params: { tabId: 'tab-a' }, confirm: true } });
    assert.equal(second.status, 200);
    assert.ok(audit.lines.some((l) => /action=disconnect connection=tab-a COM5 \(Door Cut\) result=success/.test(l) && /ip=127\.0\.0\.1/.test(l)), audit.lines.join('\n'));
    assert.ok(audit.lines.some((l) => /action=disconnect .*result=failure reason=confirmation_required/.test(l)));
  });
});

test('the audit log never contains the password, the session token or the CSRF token', async () => {
  await withServer({}, async ({ port, audit }) => {
    await login(port, 'a wrong password');
    const session = await login(port);
    await request(port, { method: 'POST', path: '/admin/api/action', headers: authed(session), body: { action: 'connect', params: { tabId: 'tab-a' } } });
    const all = audit.lines.join('\n');
    for (const secret of [PASSWORD, 'a wrong password', session.cookie.split('=')[1], session.csrf]) assert.ok(!all.includes(secret), secret);
  });
});

test('logs: only named sources are served, newest first, redacted', async () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'ra-server-logs-'));
  try {
    fs.writeFileSync(nodePath.join(dir, 'com-bridge-2026-11-02.log'), '2026-11-02T09:00:00.000Z INFO  COM5 connected\n2026-11-02T09:01:00.000Z WARN  token=abcdefgh1234 leaked\n');
    await withServer({ logSources: { 'com-bridge': { dir, prefix: 'com-bridge' } } }, async ({ port }) => {
      const session = await login(port);
      const ok = await request(port, { path: '/admin/api/logs?source=com-bridge&limit=50', headers: { Cookie: session.cookie } });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json.entries.map((e) => e.message), ['token=*** leaked', 'COM5 connected']);
      const bad = await request(port, { path: '/admin/api/logs?source=..%2F..%2Fsecrets', headers: { Cookie: session.cookie } });
      assert.equal(bad.status, 400);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CA certificate (public half only) can be downloaded for the other PC to trust', async () => {
  await withServer({}, async ({ port }) => {
    const res = await request(port, { path: '/admin/ca.crt' });
    assert.equal(res.status, 200);
    assert.match(res.text, /BEGIN CERTIFICATE/);
    assert.doesNotMatch(res.text, /PRIVATE KEY/);
  });
});

test('revoking sessions (e.g. after a password change) signs everyone out at once', async () => {
  await withServer({}, async ({ port, handle }) => {
    const session = await login(port);
    handle.revokeSessions();
    assert.equal((await request(port, { path: '/admin/api/state', headers: { Cookie: session.cookie } })).status, 401);
  });
});

test('the login limiter is shared across requests so a fresh connection does not reset it', async () => {
  const loginLimiter = new LoginLimiter({ maxPerIp: 2 });
  await withServer({ loginLimiter }, async ({ port }) => {
    await login(port, 'nope nope 1');
    await login(port, 'nope nope 2');
    assert.equal((await login(port)).res.status, 429);
  });
});

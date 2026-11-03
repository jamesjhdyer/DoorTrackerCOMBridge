'use strict';

// Drives admin-entry.js as a REAL forked child process, exactly as main.js
// does: this test plays the part of main.js, answering the child's action
// requests over IPC, and signs in to it over real HTTPS.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');
const net = require('node:net');
const nodePath = require('node:path');
const { fork } = require('node:child_process');

const { saveAdminConfig, savePasswordRecord, configPath, passwordPath, certsDir } = require('./admin-config');
const { hashPassword } = require('./admin-auth');

const ENTRY = nodePath.join(__dirname, 'admin-entry.js');
const PASSWORD = 'upstairs pc 2026';
let nextPort = 9760;

function makeHome() {
  const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'ra-entry-'));
  const home = nodePath.join(base, 'remote-admin');
  const logs = nodePath.join(base, 'logs');
  return { base, home, logs, cleanup: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

function spawnAdmin(env, onRequest) {
  const child = fork(ENTRY, [], {
    env: { ...process.env, REMOTE_ADMIN_HOME: env.home, REMOTE_ADMIN_LOGS_DIR: env.logs },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const statuses = [];
  const requests = [];
  child.on('message', async (m) => {
    if (m && m.event === 'status') statuses.push(m.status);
    if (m && m.type === 'request') {
      requests.push([m.action, m.params, m.meta]);
      const reply = await onRequest(m.action, m.params);
      child.send({ type: 'response', requestId: m.requestId, reply });
    }
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, statuses, requests, exited, output: () => output };
}

async function waitFor(predicate, { timeoutMs = 15000, stepMs = 50 } = {}) {
  const attempts = Math.ceil(timeoutMs / stepMs);
  for (let i = 0; i < attempts && !predicate(); i++) await new Promise((r) => setTimeout(r, stepMs));
  return predicate();
}

function request(port, ca, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const allHeaders = { Host: `localhost:${port}`, ...headers };
    if (payload !== undefined) Object.assign(allHeaders, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Origin: `https://localhost:${port}` });
    const req = https.request({ host: '127.0.0.1', port, method, path, headers: allHeaders, ca, servername: 'localhost', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

test('switched off (or with no password), it reports "off" and does not listen at all', async () => {
  const env = makeHome();
  const port = nextPort++;
  saveAdminConfig({ enabled: true, port }, configPath(env.home)); // enabled but no password yet
  const admin = spawnAdmin(env, async () => ({ ok: true, result: {} }));
  try {
    assert.ok(await waitFor(() => admin.statuses.some((s) => s.state === 'off')), admin.output());
    assert.match(admin.statuses.find((s) => s.state === 'off').lastError, /password/);
    assert.equal(await portIsOpen(port), false);
  } finally {
    admin.child.kill('SIGKILL');
    await admin.exited;
    env.cleanup();
  }
});

test('end to end: it listens over HTTPS, a signed-in browser\'s actions reach the parent over IPC, and the audit log records them', async () => {
  const env = makeHome();
  const port = nextPort++;
  saveAdminConfig({ enabled: true, port }, configPath(env.home));
  savePasswordRecord(await hashPassword(PASSWORD), passwordPath(env.home));

  const admin = spawnAdmin(env, async (action) => {
    if (action === 'get-state') return { ok: true, result: { summary: { total: 1, connected: 1, errors: 0 }, scanners: [{ id: 'tab-a', comPort: 'COM5' }] } };
    if (action === 'reconnect') return { ok: true, result: { audit: 'COM5 (Door Cut)' } };
    return { ok: false, error: 'unknown_action', message: 'Unknown action.' };
  });
  try {
    assert.ok(await waitFor(() => admin.statuses.some((s) => s.state === 'running')), admin.output() + JSON.stringify(admin.statuses));
    const running = admin.statuses.find((s) => s.state === 'running');
    assert.equal(running.port, port);
    assert.match(running.caFingerprint, /^[0-9A-F:]+$/);
    assert.ok(running.urls.every((u) => u.startsWith('https://') && u.endsWith(`:${port}/admin/`)));
    assert.ok(!fs.readFileSync(nodePath.join(certsDir(env.home), 'ca-cert.pem'), 'utf8').includes('PRIVATE'));

    const ca = fs.readFileSync(nodePath.join(certsDir(env.home), 'ca-cert.pem'), 'utf8');
    const signIn = await request(port, ca, { method: 'POST', path: '/admin/api/login', body: { password: PASSWORD } });
    assert.equal(signIn.status, 200);
    const cookie = signIn.headers['set-cookie'][0].split(';')[0];
    const csrf = signIn.json.csrfToken;

    const state = await request(port, ca, { path: '/admin/api/state', headers: { Cookie: cookie } });
    assert.equal(state.status, 200);
    assert.equal(state.json.result.scanners[0].comPort, 'COM5');

    const action = await request(port, ca, { method: 'POST', path: '/admin/api/action', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: { action: 'reconnect', params: { tabId: 'tab-a' } } });
    assert.equal(action.status, 200);
    assert.deepEqual(admin.requests.map((r) => r[0]), ['get-state', 'reconnect']);
    assert.deepEqual(admin.requests[1][1], { tabId: 'tab-a', confirm: false });

    // The local app changed the password: every browser is signed out.
    admin.child.send({ cmd: 'revoke-sessions' });
    await new Promise((r) => setTimeout(r, 200)); // the IPC message is asynchronous
    assert.equal((await request(port, ca, { path: '/admin/api/state', headers: { Cookie: cookie } })).status, 401);

    const auditFile = fs.readdirSync(env.logs).find((n) => /^remote-admin-\d{4}-\d{2}-\d{2}\.log$/.test(n));
    const audit = fs.readFileSync(nodePath.join(env.logs, auditFile), 'utf8');
    assert.match(audit, /AUDIT ip=127\.0\.0\.1 action=login result=success/);
    assert.match(audit, /AUDIT ip=127\.0\.0\.1 action=reconnect connection=tab-a COM5 \(Door Cut\) result=success/);
    assert.match(audit, /action=revoke-sessions/);
    for (const secret of [PASSWORD, cookie.split('=')[1], csrf]) assert.ok(!audit.includes(secret));

    admin.child.send({ cmd: 'stop' });
    assert.equal(await admin.exited, 0);
    assert.equal(await portIsOpen(port), false, 'the listener is really gone');
  } finally {
    admin.child.kill('SIGKILL');
    await admin.exited;
    env.cleanup();
  }
});

test('switching it off from the Windows app (a reload) closes the listener without ending the process', async () => {
  const env = makeHome();
  const port = nextPort++;
  saveAdminConfig({ enabled: true, port }, configPath(env.home));
  savePasswordRecord(await hashPassword(PASSWORD), passwordPath(env.home));
  const admin = spawnAdmin(env, async () => ({ ok: true, result: {} }));
  try {
    assert.ok(await waitFor(() => admin.statuses.some((s) => s.state === 'running')), admin.output());
    saveAdminConfig({ enabled: false, port }, configPath(env.home));
    admin.child.send({ cmd: 'reload' });
    assert.ok(await waitFor(() => admin.statuses.at(-1).state === 'off'));
    assert.equal(await portIsOpen(port), false);
    assert.equal(admin.child.exitCode, null);
  } finally {
    admin.child.kill('SIGKILL');
    await admin.exited;
    env.cleanup();
  }
});

test('if the parent goes away, the process stops instead of leaving an orphaned listener', async () => {
  const env = makeHome();
  const port = nextPort++;
  saveAdminConfig({ enabled: true, port }, configPath(env.home));
  savePasswordRecord(await hashPassword(PASSWORD), passwordPath(env.home));
  const admin = spawnAdmin(env, async () => ({ ok: true, result: {} }));
  try {
    assert.ok(await waitFor(() => admin.statuses.some((s) => s.state === 'running')), admin.output());
    admin.child.disconnect();
    assert.equal(await admin.exited, 0);
    assert.equal(await portIsOpen(port), false);
  } finally {
    admin.child.kill('SIGKILL');
    env.cleanup();
  }
});

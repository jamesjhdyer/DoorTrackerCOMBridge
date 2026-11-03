'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const { readRecentLogs, redact } = require('./log-reader');

function withLogs(fn) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'ra-logs-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('returns the newest entries first, across daily files, with severity, timestamp and component', () => {
  withLogs((dir) => {
    fs.writeFileSync(nodePath.join(dir, 'com-bridge-2026-11-01.log'), '2026-11-01T10:00:00.000Z INFO  old one\n2026-11-01T11:00:00.000Z WARN  old two\n');
    fs.writeFileSync(nodePath.join(dir, 'com-bridge-2026-11-02.log'), '2026-11-02T09:00:00.000Z ERROR COM5 port error: gone\nnot a log line\n2026-11-02T09:30:00.000Z INFO  COM5 connected\n');
    fs.writeFileSync(nodePath.join(dir, 'delivery-photos-2026-11-02.log'), '2026-11-02T09:45:00.000Z INFO  not this source\n');

    const sources = { 'com-bridge': { dir, prefix: 'com-bridge' } };
    const entries = readRecentLogs(sources, 'com-bridge', 3);
    assert.deepEqual(entries.map((e) => e.message), ['COM5 connected', 'COM5 port error: gone', 'old two']);
    assert.deepEqual(entries[1], { timestamp: '2026-11-02T09:00:00.000Z', level: 'ERROR', message: 'COM5 port error: gone', component: 'com-bridge' });
  });
});

test('only a named source can be read - never a path from the request', () => {
  withLogs((dir) => {
    const sources = { 'com-bridge': { dir, prefix: 'com-bridge' } };
    assert.equal(readRecentLogs(sources, '../../etc/passwd'), null);
    assert.equal(readRecentLogs(sources, 'constructor'), null);
    assert.equal(readRecentLogs(sources, '__proto__'), null);
    assert.deepEqual(readRecentLogs({ x: { dir: nodePath.join(dir, 'missing'), prefix: 'x' } }, 'x'), []);
  });
});

test('secrets are redacted before anything is served', () => {
  const samples = [
    'Authorization: Bearer abcdef0123456789abcdef0123456789',
    'password=hunter2hunter2',
    'pin: 12345678',
    'token=abc.def',
    'session cookie=__Host-dtadmin=xyz',
    'hash 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop',
    '-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----'
  ];
  for (const text of samples) {
    const out = redact(text);
    for (const secret of ['abcdef0123456789abcdef0123456789', 'hunter2hunter2', '12345678', 'abc.def', 'xyz', '0123456789abcdef0123456789abcdef', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'MIIEv']) {
      assert.ok(!out.includes(secret), `${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
    }
  }
  assert.equal(redact('COM5 connected at 19200 baud'), 'COM5 connected at 19200 baud');
});

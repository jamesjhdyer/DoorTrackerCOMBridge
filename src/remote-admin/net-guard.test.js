'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { isPrivateAddress, hostAllowed, parseHostHeader, computerName } = require('./net-guard');

test('only private, link-local and loopback peers are allowed to connect', () => {
  for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.40', '127.0.0.1', '169.254.10.10', '::1', '::ffff:192.168.1.40', 'fd12:3456::1', 'fe80::1%eth0']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.64.0.1', '81.2.69.160', '::ffff:8.8.8.8', '2001:4860:4860::8888', '', 'not-an-ip', undefined]) {
    assert.equal(isPrivateAddress(ip), false, String(ip));
  }
});

test('the Host header must name this PC on the listening port', () => {
  const names = new Set(['localhost', '127.0.0.1', '192.168.1.40', 'workshop-pc', 'workshop-pc.local', '::1']);
  assert.equal(hostAllowed('localhost:8445', 8445, names), true);
  assert.equal(hostAllowed('192.168.1.40:8445', 8445, names), true);
  assert.equal(hostAllowed('WORKSHOP-PC.local:8445', 8445, names), true);
  assert.equal(hostAllowed('[::1]:8445', 8445, names), true);
  assert.equal(hostAllowed('workshop-pc', 8445, names), true, 'no port in the header is allowed');

  assert.equal(hostAllowed('localhost:9999', 8445, names), false, 'wrong port');
  assert.equal(hostAllowed('evil.example.com:8445', 8445, names), false, 'DNS rebinding');
  assert.equal(hostAllowed('', 8445, names), false);
  assert.equal(hostAllowed('localhost:8445/../x', 8445, names), false);
  assert.equal(hostAllowed(undefined, 8445, names), false);
});

test('the computer name followed by the network DNS suffix is accepted, look-alikes are not', () => {
  const name = computerName();
  if (!name) return;
  assert.equal(hostAllowed(`${name}.office.lan:8445`, 8445, new Set()), true);
  assert.equal(hostAllowed(`${name}x.office.lan:8445`, 8445, new Set()), false);
  assert.equal(hostAllowed(`evil-${name}.office.lan:8445`, 8445, new Set()), false);
  assert.ok(os.hostname());
});

test('parseHostHeader splits name and port', () => {
  assert.deepEqual(parseHostHeader('Example.Local:8445'), { name: 'example.local', port: 8445 });
  assert.deepEqual(parseHostHeader('[fe80::1]:1'), { name: 'fe80::1', port: 1 });
  assert.equal(parseHostHeader('bad host'), null);
});

'use strict';

// actions.js against a fake COM Bridge: the real com-settings.js edit logic,
// with openConnection/closeConnection/saveSettings recorded instead of
// touching serial ports or the disk.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminActions, ACTION_NAMES } = require('./actions');

function fakeBridge({ connected = [], errored = [] } = {}) {
  let settings = {
    apiUrl: 'https://example.test/api/com-scans',
    tabs: [
      { id: 'tab-a', comPort: 'COM5', baudRate: 19200, stationKey: 'door_cutting' },
      { id: 'tab-b', comPort: 'COM6', baudRate: 19200, stationKey: 'frame_cutting' },
      { id: 'tab-c', comPort: 'COM7', baudRate: 19200, stationKey: 'joint_prehung' }
    ]
  };
  const live = new Set(connected);
  const failed = new Set(errored);
  const calls = [];
  const deps = {
    platform: 'win32',
    loadSettings: () => structuredClone(settings),
    saveSettings: (next) => {
      calls.push(['save', next.tabs.map((t) => `${t.id}:${t.comPort}:${t.baudRate}:${t.stationKey}`)]);
      settings = structuredClone(next);
      return settings;
    },
    listPorts: async () => [{ path: 'COM5', manufacturer: 'NETUM' }, { path: 'COM9' }],
    connectionState: (tabId) => ({ connected: live.has(tabId), status: live.has(tabId) ? 'connected' : failed.has(tabId) ? 'error' : 'disconnected', lastScanAt: tabId === 'tab-a' ? '2026-11-02T14:32:18.000Z' : null, lastScanValue: tabId === 'tab-a' ? '5698-D-01' : null }),
    openConnection: async (tab, apiUrl) => {
      calls.push(['open', tab.id, tab.comPort, tab.baudRate, tab.stationKey, apiUrl]);
      await new Promise((r) => setTimeout(r, 5));
      live.add(tab.id);
      failed.delete(tab.id);
      return { ok: true };
    },
    closeConnection: async (tabId) => {
      calls.push(['close', tabId]);
      await new Promise((r) => setTimeout(r, 5));
      live.delete(tabId);
      return { ok: true };
    }
  };
  return { actions: createAdminActions(deps), calls, deps, settings: () => settings, live };
}

test('get-state reports each scanner, the connected count and the most recent scan', async () => {
  const { actions } = fakeBridge({ connected: ['tab-a', 'tab-b'], errored: ['tab-c'] });
  const reply = await actions.handle('get-state', {});
  assert.equal(reply.ok, true);
  const state = reply.result;
  assert.deepEqual(state.summary, { total: 3, connected: 2, errors: 1 });
  assert.deepEqual(state.scanners.map((s) => [s.comPort, s.stationLabel, s.state]), [['COM5', 'Door Cut', 'connected'], ['COM6', 'Frame Cut & Mould', 'connected'], ['COM7', 'Pre-Hung', 'error']]);
  assert.deepEqual(state.lastScan, { comPort: 'COM5', stationLabel: 'Door Cut', value: '5698-D-01', at: '2026-11-02T14:32:18.000Z' });
  assert.ok(state.options.baudRates.includes(19200));
  assert.ok(!JSON.stringify(state).includes('apiUrl'), 'the website address is not part of the admin state');
});

test('an unknown action, or one with a malformed target, is refused without touching anything', async () => {
  const { actions, calls } = fakeBridge();
  assert.equal((await actions.handle('run-command', { cmd: 'shutdown' })).error, 'unknown_action');
  assert.equal((await actions.handle('__proto__', {})).error, 'unknown_action');
  assert.equal((await actions.handle('connect', { tabId: { $ne: 1 } })).error, 'not_found');
  assert.equal((await actions.handle('connect', null)).error, 'not_found');
  assert.deepEqual(calls, []);
  assert.ok(!ACTION_NAMES.some((name) => /write|send|exec|shell|reboot|shutdown/.test(name)), 'no action can send serial data or run anything');
});

test('connect opens exactly that tab with its saved settings and the saved website address', async () => {
  const { actions, calls } = fakeBridge();
  const reply = await actions.handle('connect', { tabId: 'tab-b' });
  assert.equal(reply.ok, true);
  assert.deepEqual(calls, [['open', 'tab-b', 'COM6', 19200, 'frame_cutting', 'https://example.test/api/com-scans']]);
  assert.equal((await actions.handle('connect', { tabId: 'tab-b' })).error, 'already_connected');
});

test('disconnect needs confirmation; reconnecting a failed port does not, reconnecting a working one does', async () => {
  const { actions, calls } = fakeBridge({ connected: ['tab-a'], errored: ['tab-c'] });

  const unconfirmed = await actions.handle('disconnect', { tabId: 'tab-a' });
  assert.equal(unconfirmed.error, 'confirmation_required');
  assert.match(unconfirmed.message, /COM5/);
  assert.deepEqual(calls, []);

  assert.equal((await actions.handle('reconnect', { tabId: 'tab-c' })).ok, true);
  assert.deepEqual(calls, [['close', 'tab-c'], ['open', 'tab-c', 'COM7', 19200, 'joint_prehung', 'https://example.test/api/com-scans']]);

  assert.equal((await actions.handle('reconnect', { tabId: 'tab-a' })).error, 'confirmation_required');
  assert.equal((await actions.handle('reconnect', { tabId: 'tab-a', confirm: true })).ok, true);
  assert.equal((await actions.handle('disconnect', { tabId: 'tab-a', confirm: true })).ok, true);
  assert.deepEqual(calls.at(-1), ['close', 'tab-a']);
});

test('restart-all needs confirmation and only restarts connected or failed connections', async () => {
  const { actions, calls } = fakeBridge({ connected: ['tab-a'], errored: ['tab-c'] });
  assert.equal((await actions.handle('restart-all', {})).error, 'confirmation_required');
  assert.deepEqual(calls, []);
  const reply = await actions.handle('restart-all', { confirm: true });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result.results.map((r) => [r.comPort, r.ok]), [['COM5', true], ['COM7', true]]);
  assert.ok(!calls.some((c) => c[1] === 'tab-b'), 'the deliberately disconnected tab is left alone');
});

test('update-connection validates with the shared rules and saves nothing when invalid', async () => {
  const { actions, calls } = fakeBridge();
  for (const bad of [{ baudRate: 12345 }, { stationKey: 'nope' }, { comPort: 'C:\\Windows' }, { comPort: 'COM6' }]) {
    const reply = await actions.handle('update-connection', { tabId: 'tab-a', ...bad, confirm: true });
    assert.equal(reply.ok, false, JSON.stringify(bad));
    assert.equal(reply.error, 'invalid');
  }
  assert.deepEqual(calls, []);
});

test('changing a disconnected tab\'s station saves without confirmation or any reconnect', async () => {
  const { actions, calls, settings } = fakeBridge();
  const reply = await actions.handle('update-connection', { tabId: 'tab-b', stationKey: 'frame_sanding' });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result.changed, ['stationKey']);
  assert.equal(reply.result.reconnected, false);
  assert.deepEqual(calls, [['save', ['tab-a:COM5:19200:door_cutting', 'tab-b:COM6:19200:frame_sanding', 'tab-c:COM7:19200:joint_prehung']]]);
  assert.equal(settings().tabs[1].stationKey, 'frame_sanding');
});

test('changing a COM port needs confirmation, and a connected tab is reconnected - and only that tab', async () => {
  const { actions, calls } = fakeBridge({ connected: ['tab-a', 'tab-b'] });
  const first = await actions.handle('update-connection', { tabId: 'tab-a', comPort: 'COM9', baudRate: 9600 });
  assert.equal(first.error, 'confirmation_required');
  assert.deepEqual(calls, []);

  const reply = await actions.handle('update-connection', { tabId: 'tab-a', comPort: 'COM9', baudRate: 9600, confirm: true });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.reconnected, true);
  assert.deepEqual(calls, [
    ['close', 'tab-a'],
    ['save', ['tab-a:COM9:9600:door_cutting', 'tab-b:COM6:19200:frame_cutting', 'tab-c:COM7:19200:joint_prehung']],
    ['open', 'tab-a', 'COM9', 9600, 'door_cutting', 'https://example.test/api/com-scans']
  ]);
});

test('an unchanged edit is a no-op', async () => {
  const { actions, calls } = fakeBridge({ connected: ['tab-a'] });
  const reply = await actions.handle('update-connection', { tabId: 'tab-a', comPort: 'COM5', baudRate: 19200, stationKey: 'door_cutting' });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result.changed, []);
  assert.deepEqual(calls, []);
});

test('add-connection validates and saves; remove-connection needs confirmation and disconnects first', async () => {
  const { actions, calls, settings } = fakeBridge({ connected: ['tab-c'] });
  assert.equal((await actions.handle('add-connection', { comPort: 'COM10', baudRate: 7, stationKey: 'door_press' })).error, 'invalid');
  const added = await actions.handle('add-connection', { comPort: 'com10', baudRate: 19200, stationKey: 'door_press' });
  assert.equal(added.ok, true);
  assert.equal(settings().tabs.at(-1).comPort, 'COM10');
  assert.ok(!calls.some((c) => c[0] === 'open'), 'a new connection is not opened automatically');

  assert.equal((await actions.handle('remove-connection', { tabId: 'tab-c' })).error, 'confirmation_required');
  const removed = await actions.handle('remove-connection', { tabId: 'tab-c', confirm: true });
  assert.equal(removed.ok, true);
  assert.deepEqual(calls.slice(-2).map((c) => c[0]), ['close', 'save']);
  assert.ok(!settings().tabs.some((t) => t.id === 'tab-c'));
});

test('changes run one at a time, so two quick reconnects never interleave a close and an open', async () => {
  const { actions, calls } = fakeBridge({ errored: ['tab-a'] });
  await Promise.all([actions.handle('reconnect', { tabId: 'tab-a' }), actions.handle('reconnect', { tabId: 'tab-a', confirm: true })]);
  assert.deepEqual(calls.map((c) => c[0]), ['close', 'open', 'close', 'open']);
});

test('list-ports returns only the port path and manufacturer', async () => {
  const { actions } = fakeBridge();
  const reply = await actions.handle('list-ports', {});
  assert.deepEqual(reply.result.ports, [{ path: 'COM5', manufacturer: 'NETUM' }, { path: 'COM9', manufacturer: '' }]);
});

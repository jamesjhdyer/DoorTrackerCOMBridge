'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const { validateConnectionSettings, BAUD_RATES, STATIONS } = require('./com-options');
const comSettings = require('./com-settings');

const WIN = { platform: 'win32' };

function sample() {
  return {
    apiUrl: 'https://example.test/api/com-scans',
    tabs: [
      { id: 'tab-a', comPort: 'COM5', baudRate: 19200, stationKey: 'door_cutting' },
      { id: 'tab-b', comPort: 'COM6', baudRate: 9600, stationKey: 'frame_cutting' }
    ]
  };
}

test('validateConnectionSettings accepts exactly the stations and baud rates the Windows app offers', () => {
  for (const rate of BAUD_RATES) {
    for (const station of STATIONS) {
      assert.ok(validateConnectionSettings({ comPort: 'COM3', baudRate: rate, stationKey: station.key }, WIN).ok);
    }
  }
});

test('validateConnectionSettings refuses unknown baud rates, stations and anything that is not a COM port name', () => {
  const bad = [
    { comPort: 'COM3', baudRate: 12345, stationKey: 'door_cutting' },
    { comPort: 'COM3', baudRate: 19200, stationKey: 'not_a_station' },
    { comPort: '..\\..\\Windows', baudRate: 19200, stationKey: 'door_cutting' },
    { comPort: 'COM3 & calc', baudRate: 19200, stationKey: 'door_cutting' },
    { comPort: '\\\\.\\COM3', baudRate: 19200, stationKey: 'door_cutting' },
    { comPort: 'COM0', baudRate: 19200, stationKey: 'door_cutting' },
    { comPort: '', baudRate: 19200, stationKey: 'door_cutting' }
  ];
  for (const input of bad) {
    const result = validateConnectionSettings(input, WIN);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.ok(result.errors.length > 0);
  }
});

test('validateConnectionSettings normalises a lower-case Windows port name', () => {
  assert.deepEqual(validateConnectionSettings({ comPort: ' com7 ', baudRate: '9600', stationKey: 'door_press' }, WIN).value, { comPort: 'COM7', baudRate: 9600, stationKey: 'door_press' });
});

test('updateConnection changes only the named tab and returns a new settings object', () => {
  const settings = sample();
  const result = comSettings.updateConnection(settings, 'tab-a', { comPort: 'COM9', stationKey: 'door_press' }, WIN);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tab, { id: 'tab-a', comPort: 'COM9', baudRate: 19200, stationKey: 'door_press' });
  assert.deepEqual(result.settings.tabs[1], settings.tabs[1]);
  assert.equal(settings.tabs[0].comPort, 'COM5', 'the input must not be modified');
  assert.equal(result.settings.apiUrl, settings.apiUrl);
});

test('updateConnection ignores id/apiUrl in the edit and refuses a port already used by another tab', () => {
  const settings = sample();
  const sneaky = comSettings.updateConnection(settings, 'tab-a', { id: 'other', apiUrl: 'https://evil.test' }, WIN);
  assert.equal(sneaky.tab.id, 'tab-a');
  assert.equal(sneaky.settings.apiUrl, settings.apiUrl);

  const clash = comSettings.updateConnection(settings, 'tab-a', { comPort: 'com6' }, WIN);
  assert.equal(clash.ok, false);
  assert.match(clash.errors[0], /already assigned/);
});

test('addConnection and removeConnection validate, and the last connection cannot be removed', () => {
  const added = comSettings.addConnection(sample(), { comPort: 'COM8', baudRate: 19200, stationKey: 'joint_prehung' }, WIN);
  assert.equal(added.ok, true);
  assert.equal(added.settings.tabs.length, 3);
  assert.ok(added.tab.id);

  assert.equal(comSettings.addConnection(sample(), { comPort: 'COM8', baudRate: 1, stationKey: 'joint_prehung' }, WIN).ok, false);

  const removed = comSettings.removeConnection(sample(), 'tab-b');
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.settings.tabs.map((t) => t.id), ['tab-a']);
  assert.equal(comSettings.removeConnection(removed.settings, 'tab-a').ok, false);
  assert.equal(comSettings.removeConnection(sample(), 'missing').ok, false);
});

test('saveSettings writes atomically and loadSettings still reads the older single-connection shape', () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'com-settings-'));
  try {
    const file = nodePath.join(dir, 'settings.json');
    comSettings.saveSettings(file, sample());
    assert.deepEqual(comSettings.loadSettings(file), sample());
    assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'no temp file left behind');

    fs.writeFileSync(file, JSON.stringify({ comPort: 'COM4', baudRate: 9600, stationKey: 'door_press', apiUrl: 'x' }));
    const legacy = comSettings.loadSettings(file);
    assert.equal(legacy.tabs.length, 1);
    assert.equal(legacy.tabs[0].comPort, 'COM4');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

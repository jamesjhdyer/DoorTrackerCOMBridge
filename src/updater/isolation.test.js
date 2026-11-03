'use strict';

// Guards around the updater that are about the rest of the app, not the
// update flow itself:
//   - Remote Admin has no way to check for, download, install or roll back
//     an update - updates are started from the local Windows app only;
//   - everything the app persists lives under Electron's user data folder,
//     never next to the program files an installer replaces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

const { ACTION_NAMES, createAdminActions } = require('../remote-admin/actions');

const SRC = nodePath.join(__dirname, '..');
const read = (relative) => fs.readFileSync(nodePath.join(SRC, relative), 'utf8');

test('Remote Admin has no update, download, install or rollback action', async () => {
  // 'update-connection' edits a COM connection's settings - not software.
  for (const name of ACTION_NAMES.filter((n) => n !== 'update-connection')) {
    assert.doesNotMatch(name, /updat|install|download|release|rollback|downgrade|version|restart-app/i, name);
  }

  const actions = createAdminActions({
    loadSettings: () => ({ apiUrl: '', tabs: [] }),
    saveSettings: () => assert.fail('nothing may be saved'),
    listPorts: async () => [],
    connectionState: () => ({}),
    openConnection: async () => assert.fail('nothing may be opened'),
    closeConnection: async () => assert.fail('nothing may be closed')
  });
  for (const attempt of ['check-updates', 'download-update', 'install-update', 'updates-install', 'rollback']) {
    assert.equal((await actions.handle(attempt, { version: '1.2.0', confirmed: true })).error, 'unknown_action', attempt);
  }
});

test('no Remote Admin code can reach the updater, and main.js gives it no updater access', () => {
  for (const name of fs.readdirSync(nodePath.join(SRC, 'remote-admin')).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'))) {
    assert.doesNotMatch(read(`remote-admin/${name}`), /updater|electron-updater|appUpdates/, `remote-admin/${name}`);
  }
  const main = read('main.js');
  const adminWiring = main.slice(main.indexOf('const adminActions = createAdminActions('), main.indexOf('function remoteAdminPaths('));
  assert.ok(adminWiring.length > 100, 'found the Remote Admin wiring in main.js');
  assert.doesNotMatch(adminWiring, /updates|updater|quitAndInstall/);
});

test('everything main.js writes lives under app.getPath(\'userData\'), never beside the program files', () => {
  const main = read('main.js');
  // __dirname (inside the installed app) is used only to LOCATE the app's own code files.
  const codeOnly = new Set(["path.join(__dirname, 'delivery-photos', 'worker-entry.js')", "path.join(__dirname, 'remote-admin', 'admin-entry.js')", "path.join(__dirname, 'preload.js')", "path.join(__dirname, 'index.html')"]);
  for (const use of main.match(/path\.join\(__dirname[^)]*\)/g) || []) assert.ok(codeOnly.has(use), `unexpected __dirname path in main.js: ${use}`);
  assert.doesNotMatch(main, /process\.resourcesPath|getAppPath\(\)|path\.dirname\(process\.execPath\)\s*,\s*['"]/);

  for (const home of ['settings.json', "'logs'", "'delivery-photos'", "'remote-admin'", "'print-attempts.json'"]) {
    assert.ok(main.includes(`path.join(app.getPath('userData'), ${home.startsWith("'") ? home : `'${home}'`})`), `${home} is under userData`);
  }
  assert.match(read('printer-settings.js'), /path\.join\(app\.getPath\('userData'\), 'printer-settings\.json'\)/);
  // The two worker processes get their folders from main.js (under userData) via the environment.
  assert.match(main, /DELIVERY_PHOTOS_HOME: DELIVERY_PHOTOS_HOME\(\)/);
  assert.match(main, /REMOTE_ADMIN_HOME: REMOTE_ADMIN_HOME\(\)/);
});

test('the installer keeps user data on uninstall/upgrade, and installs are refused if settings sit inside the program folder', () => {
  const pkg = JSON.parse(fs.readFileSync(nodePath.join(SRC, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.build.nsis.artifactName, 'DoorTrackerCOMBridge-Setup-${version}.${ext}');
  assert.match(read('main.js'), /isPathInside\(app\.getPath\('userData'\), path\.dirname\(process\.execPath\)\)/);
});

test('nothing in the app starts an update check, download or install on its own', () => {
  const main = read('main.js');
  const section = main.slice(main.indexOf('// ---- Updates (GitHub Releases) ----'));
  assert.doesNotMatch(section, /setInterval|setTimeout|whenReady|checkForUpdatesAndNotify|autoUpdater\b/);
  assert.match(section, /autoDownload = false/);
  assert.match(section, /autoInstallOnAppQuit = false/);
  assert.match(section, /allowPrerelease = false/);
});

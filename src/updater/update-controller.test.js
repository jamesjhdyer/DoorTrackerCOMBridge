'use strict';

// The Updates flow against a fake GitHub and a fake electron-updater - no
// network, no Electron, nothing real is downloaded or installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUpdateController } = require('./update-controller');
const { installerName } = require('./releases');

const BASE = 'https://github.com/jamesjhdyer/DoorTrackerCOMBridge/releases/download';

function apiRelease(version, fields = {}) {
  const tag = `v${version}`;
  const asset = (name) => ({ name, browser_download_url: `${BASE}/${tag}/${name}`, size: 1000 });
  return { tag_name: tag, draft: false, prerelease: false, published_at: '2026-11-03T10:00:00Z', html_url: `https://github.com/jamesjhdyer/DoorTrackerCOMBridge/releases/tag/${tag}`, assets: [asset(installerName(version)), asset('latest.yml')], ...fields };
}

const GOOD_INFO = (version) => ({ version, files: [{ url: installerName(version), sha512: 'a'.repeat(88), size: 1000 }] });

class FakeUpdater extends EventEmitter {
  constructor(options, behaviour) {
    super();
    this.options = options;
    this.behaviour = behaviour;
    this.installs = [];
  }

  async checkForUpdates() {
    if (this.behaviour.checkError) throw this.behaviour.checkError;
    const version = /\/v([^/]+)\/$/.exec(this.options.feedUrl)[1];
    return { updateInfo: this.behaviour.info ? this.behaviour.info(version) : GOOD_INFO(version), isUpdateAvailable: true };
  }

  async downloadUpdate() {
    this.emit('download-progress', { percent: 50, transferred: 500, total: 1000 });
    if (this.behaviour.downloadError) throw this.behaviour.downloadError;
    this.emit('download-progress', { percent: 100, transferred: 1000, total: 1000 });
  }

  quitAndInstall(isSilent, forceRunAfter) {
    if (this.behaviour.installError) throw this.behaviour.installError;
    this.installs.push([isSilent, forceRunAfter]);
  }
}

function setup({ current = '1.2.0', apiReleases, fetchError, behaviour = {}, support = { ok: true }, activity = { connectedScanners: 0, printJobsActive: 0 } } = {}) {
  const updaters = [];
  const states = [];
  const log = [];
  const controller = createUpdateController({
    currentVersion: current,
    fetchReleasesJson: async () => {
      if (fetchError) throw fetchError;
      return apiReleases || [apiRelease('1.3.0'), apiRelease('1.2.4'), apiRelease('1.2.0'), apiRelease('1.1.0')];
    },
    createUpdater: (options) => {
      const updater = new FakeUpdater(options, behaviour);
      updaters.push(updater);
      return updater;
    },
    installSupport: () => support,
    activity: () => activity,
    logger: { info: (m) => log.push(`INFO ${m}`), warn: (m) => log.push(`WARN ${m}`), error: (m) => log.push(`ERROR ${m}`) },
    onState: (s) => states.push(s)
  });
  return { controller, updaters, states, log };
}

test('the same version is "up to date" - no update offered', async () => {
  const { controller } = setup({ current: '1.3.0' });
  const result = await controller.check();
  assert.equal(result.status, 'up-to-date');
  assert.equal(result.latest.version, '1.3.0');
  assert.equal(result.latest.isCurrent, true);
});

test('a newer stable version is offered as the update', async () => {
  const { controller, log } = setup({ current: '1.2.0' });
  const result = await controller.check();
  assert.equal(result.status, 'available');
  assert.equal(result.latest.version, '1.3.0');
  assert.equal(result.latest.isNewer, true);
  assert.ok(log.some((l) => /latest stable release is 1\.3\.0/.test(l)));
});

test('an older release is never offered as the normal update', async () => {
  const { controller } = setup({ current: '1.10.0', apiReleases: [apiRelease('1.9.9'), apiRelease('1.2.0')] });
  const result = await controller.check();
  assert.equal(result.status, 'up-to-date', '1.9.9 is older than 1.10.0');
  assert.equal(result.latest.isOlder, true);
});

test('drafts and pre-releases are ignored by the update check', async () => {
  const { controller } = setup({ current: '1.2.0', apiReleases: [apiRelease('2.0.0', { draft: true }), apiRelease('1.9.0', { prerelease: true }), apiRelease('1.2.0')] });
  const result = await controller.check();
  assert.equal(result.status, 'up-to-date');
  assert.equal(result.latest.version, '1.2.0');
});

test('the previous-versions list shows every stable release, older ones included, with Latest/Installed marked', async () => {
  const { controller } = setup({ current: '1.2.4' });
  const result = await controller.listReleases();
  assert.equal(result.ok, true);
  assert.deepEqual(result.releases.map((r) => [r.version, r.isLatest, r.isCurrent, r.isOlder]), [
    ['1.3.0', true, false, false],
    ['1.2.4', false, true, false],
    ['1.2.0', false, false, true],
    ['1.1.0', false, false, true]
  ]);
});

test('downloading an older version requires explicit downgrade confirmation', async () => {
  const { controller, updaters } = setup({ current: '1.3.0' });
  const refused = await controller.download('1.2.4');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'downgrade_confirmation_required');
  assert.match(refused.message, /downgrade from 1\.3\.0 to 1\.2\.4/);
  assert.match(refused.message, /settings will be preserved/i);
  assert.equal(updaters.length, 0, 'nothing was downloaded');

  const confirmed = await controller.download('1.2.4', { confirmDowngrade: true });
  assert.equal(confirmed.ok, true);
  assert.equal(updaters[0].options.allowDowngrade, true);
  assert.equal(updaters[0].options.feedUrl, `${BASE}/v1.2.4/`);
});

test('a normal update download uses that release\'s own feed, never allows a downgrade, and reports progress', async () => {
  const { controller, updaters, states, log } = setup({ current: '1.2.0' });
  const result = await controller.download('1.3.0');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'downloaded');
  assert.equal(updaters[0].options.allowDowngrade, false);
  assert.ok(states.some((s) => s.status === 'downloading' && s.progress && s.progress.percent === 50));
  assert.ok(log.some((l) => /Download started: 1\.3\.0/.test(l)) && log.some((l) => /Download completed and verified: 1\.3\.0/.test(l)));
});

test('the same version, or one that is not an installable release, cannot be downloaded', async () => {
  const { controller, updaters } = setup({ current: '1.3.0' });
  assert.equal((await controller.download('1.3.0')).error, 'same_version');
  assert.equal((await controller.download('9.9.9')).error, 'not_found');
  assert.equal((await controller.download('../../evil')).error, 'not_found');
  assert.equal(updaters.length, 0);
});

test('update metadata that does not match the chosen release is refused before downloading', async () => {
  const { controller, updaters } = setup({ current: '1.2.0', behaviour: { info: () => ({ version: '1.3.0', files: [{ url: 'https://evil.example.com/payload.exe', sha512: 'a'.repeat(88) }] }) } });
  const result = await controller.download('1.3.0');
  assert.equal(result.ok, false);
  assert.match(result.message, /different installer/);
  assert.equal(updaters[0].installs.length, 0);
  assert.equal(controller.install({ confirmed: true }).error, 'nothing_downloaded');
});

test('a failed download leaves the running app alone: nothing to install, and checking still works', async () => {
  const { controller, updaters, log } = setup({ current: '1.2.0', behaviour: { downloadError: new Error('sha512 checksum mismatch') } });
  const result = await controller.download('1.3.0');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.match(result.message, /Download failed: sha512 checksum mismatch/);
  assert.match(result.message, /keeps running unchanged/);
  assert.equal(updaters[0].installs.length, 0);
  assert.equal(controller.install({ confirmed: true }).error, 'nothing_downloaded');
  assert.ok(log.some((l) => /^ERROR Download of 1\.3\.0 failed/.test(l)));
  assert.equal((await controller.check()).status, 'available', 'a later check works normally');
});

test('install only runs after a verified download AND an explicit confirmation, and it is silent + restarts the app', async () => {
  const { controller, updaters, log } = setup({ current: '1.2.0', activity: { connectedScanners: 3, printJobsActive: 1 } });
  assert.equal(controller.install({ confirmed: true }).error, 'nothing_downloaded');
  await controller.download('1.3.0');

  const warning = controller.installWarning();
  assert.match(warning.message, /The COM Bridge will close briefly while the update installs\./);
  assert.match(warning.message, /Scanners will not be processed during this time\./);
  assert.match(warning.message, /3 scanner connection/);
  assert.match(warning.message, /1 print job/);
  assert.match(warning.message, /Continue\?$/);

  const unconfirmed = controller.install({});
  assert.equal(unconfirmed.error, 'confirmation_required');
  assert.equal(updaters[0].installs.length, 0);

  assert.equal(controller.install({ confirmed: true }).ok, true);
  assert.deepEqual(updaters[0].installs, [[true, true]]);
  assert.ok(log.some((l) => /Installer launched for 1\.3\.0/.test(l)));
});

test('if the installer cannot be launched, it says so and the current version keeps running', async () => {
  const { controller } = setup({ current: '1.2.0', behaviour: { installError: new Error('spawn EACCES') } });
  await controller.download('1.3.0');
  const result = controller.install({ confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'install_failed');
  assert.match(result.message, /Install failed: spawn EACCES/);
  assert.equal(result.status, 'downloaded', 'the verified download is still there to retry');
});

test('cancelling a downloaded update means nothing will be installed', async () => {
  const { controller, updaters, log } = setup({ current: '1.2.0' });
  await controller.download('1.3.0');
  controller.cancelPending();
  assert.equal(controller.install({ confirmed: true }).error, 'nothing_downloaded');
  assert.equal(updaters[0].installs.length, 0);
  assert.ok(log.some((l) => /cancelled/.test(l)));
});

test('GitHub unreachable is reported as offline; a refused request as an error', async () => {
  const offline = setup({ fetchError: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) });
  const result = await offline.controller.check();
  assert.equal(result.status, 'offline');
  assert.match(result.message, /could not be reached/);

  const limited = setup({ fetchError: Object.assign(new Error('GitHub answered 403'), { status: 403 }) });
  assert.match((await limited.controller.check()).message, /limit/);
});

test('a build that cannot install updates (portable / development) refuses to download or install', async () => {
  const { controller, updaters } = setup({ support: { ok: false, reason: 'This is the portable build, which cannot update itself.' } });
  const result = await controller.download('1.3.0');
  assert.equal(result.error, 'unsupported');
  assert.match(result.message, /portable/);
  assert.equal(updaters.length, 0);
  assert.equal(controller.getState().canInstall, false);
  assert.equal((await controller.check()).status, 'available', 'checking for updates is still allowed');
});

test('nothing happens on its own: creating the controller fetches, downloads and installs nothing', async () => {
  let fetched = 0;
  let created = 0;
  createUpdateController({
    currentVersion: '1.2.0',
    fetchReleasesJson: async () => {
      fetched++;
      return [];
    },
    createUpdater: () => {
      created++;
      return new EventEmitter();
    },
    installSupport: () => ({ ok: true }),
    activity: () => ({ connectedScanners: 0, printJobsActive: 0 }),
    logger: { info() {}, warn() {}, error() {} }
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetched, 0);
  assert.equal(created, 0);
});

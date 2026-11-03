'use strict';

// The Updates tab's flow: check GitHub for the newest stable release, list
// earlier ones, download a chosen one, and - only when the person presses
// "Restart and Install" and confirms - hand over to its installer.
//
// Nothing here ever happens on its own: there is no timer, no check at
// start-up, no download or install without a button press in the local
// Windows app (main.js's IPC handlers are the only callers; Remote Admin has
// no route to any of this - see remote-admin/actions.js).
//
// Every outside dependency is passed in, so the whole flow is unit-tested
// with fakes (see update-controller.test.js):
//   currentVersion            the running app's version
//   fetchReleasesJson()       GitHub's /releases answer (releases.js's fetchReleases)
//   createUpdater(options)    an electron-updater NsisUpdater pointed at ONE
//                             release's download folder (generic provider),
//                             with autoDownload/autoInstallOnAppQuit off
//   installSupport()          { ok } or { ok: false, reason } - e.g. not an
//                             installed (NSIS) build, or settings stored inside
//                             the install folder
//   activity()                { connectedScanners, printJobsActive } for the
//                             pre-install warning
//   logger, onState(state)
//
// Download verification is electron-updater's own: it reads the chosen
// release's latest.yml (checked here against the release first - see
// releases.js's checkUpdateInfo) and verifies the downloaded installer's
// SHA-512 against it before reporting it downloaded. A failed or unverified
// download changes nothing about the running app.

const { compareVersions, selectStableReleases, checkUpdateInfo } = require('./releases');

const OFFLINE_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function describeNetworkError(err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  if ((err && err.name === 'AbortError') || OFFLINE_CODES.has(code) || /fetch failed|net::ERR_/i.test(String(err && err.message))) {
    return { status: 'offline', message: 'GitHub could not be reached. Check this PC\'s internet connection and try again.' };
  }
  if (err && err.status === 403) return { status: 'error', message: 'GitHub refused the request (its hourly limit for this network may be used up). Try again later.' };
  if (err && err.status === 404) return { status: 'error', message: 'The release list was not found on GitHub.' };
  return { status: 'error', message: `Could not check for updates: ${String((err && err.message) || err).slice(0, 200)}` };
}

function createUpdateController(deps) {
  const { currentVersion, fetchReleasesJson, createUpdater, installSupport, activity, logger, onState = () => {} } = deps;

  let releases = null; // last good, filtered list
  let pending = null; // { release, updater } once a download has finished
  let busy = false;
  let state = { status: 'idle', currentVersion, latest: null, selected: null, progress: null, message: '' };

  function setState(patch) {
    state = { ...state, ...patch };
    try {
      onState(state);
    } catch {
      // a display problem must never affect the update itself
    }
    return state;
  }

  async function loadReleases() {
    const json = await fetchReleasesJson();
    releases = selectStableReleases(json);
    return releases;
  }

  function view(release) {
    if (!release) return null;
    const order = compareVersions(release.version, currentVersion);
    return { version: release.version, tag: release.tag, publishedAt: release.publishedAt, notesUrl: release.notesUrl, isNewer: order > 0, isCurrent: order === 0, isOlder: order < 0 };
  }

  async function check() {
    if (busy) return { ok: false, error: 'busy', message: 'Please wait for the current update step to finish.' };
    setState({ status: 'checking', message: 'Checking for updates…', progress: null });
    logger.info(`Update check started (running ${currentVersion}).`);
    try {
      await loadReleases();
    } catch (err) {
      const problem = describeNetworkError(err);
      logger.warn(`Update check failed: ${problem.message}`);
      return { ok: false, ...setState({ status: problem.status, message: problem.message }) };
    }
    const latest = releases[0] || null;
    if (!latest) {
      logger.info('Update check: no installable stable release found.');
      return { ok: true, ...setState({ status: 'up-to-date', latest: null, message: 'No installable releases have been published yet.' }) };
    }
    const newer = compareVersions(latest.version, currentVersion) > 0;
    logger.info(`Update check: latest stable release is ${latest.version}${newer ? ' - an update is available' : ' - up to date'}.`);
    return {
      ok: true,
      ...setState({
        status: newer ? 'available' : 'up-to-date',
        latest: view(latest),
        message: newer ? `Version ${latest.version} is available.` : "You're up to date."
      })
    };
  }

  async function listReleases() {
    try {
      await loadReleases();
    } catch (err) {
      const problem = describeNetworkError(err);
      logger.warn(`Could not list releases: ${problem.message}`);
      return { ok: false, error: problem.status, message: problem.message };
    }
    return { ok: true, releases: releases.map((r, i) => ({ ...view(r), isLatest: i === 0 })) };
  }

  // `confirmDowngrade` must be true to fetch a version older than the one
  // running - the Updates tab asks first, and a request that skipped the
  // question is refused here anyway.
  async function download(version, { confirmDowngrade = false } = {}) {
    if (busy) return { ok: false, error: 'busy', message: 'A download is already in progress.' };
    const support = installSupport();
    if (!support.ok) return { ok: false, error: 'unsupported', message: support.reason };

    if (!releases) {
      try {
        await loadReleases();
      } catch (err) {
        const problem = describeNetworkError(err);
        return { ok: false, error: problem.status, ...setState({ status: problem.status, message: problem.message }) };
      }
    }
    const release = releases.find((r) => r.version === String(version));
    if (!release) return { ok: false, error: 'not_found', message: `Version ${String(version).slice(0, 20)} is not an installable stable release.` };

    const order = compareVersions(release.version, currentVersion);
    if (order === 0) return { ok: false, error: 'same_version', message: `Version ${release.version} is already installed.` };
    const isDowngrade = order < 0;
    if (isDowngrade && confirmDowngrade !== true) {
      return {
        ok: false,
        error: 'downgrade_confirmation_required',
        message: `You are about to downgrade from ${currentVersion} to ${release.version}.\n\nYour settings will be preserved, but older versions may not understand newer configuration options.`
      };
    }

    busy = true;
    pending = null;
    const selected = { version: release.version, isDowngrade };
    setState({ status: 'downloading', selected, progress: { percent: 0 }, message: `Downloading ${release.version}…` });
    logger.info(`Download started: ${release.version}${isDowngrade ? ` (downgrade from ${currentVersion})` : ''}.`);

    try {
      const updater = createUpdater({ feedUrl: release.feedUrl, allowDowngrade: isDowngrade });
      // electron-updater also reports a failure to START the installer here
      // (after quitAndInstall), in which case the app does not quit.
      updater.on('error', (err) => {
        const text = String((err && err.message) || err).slice(0, 200);
        logger.error(`Updater error: ${text}`);
        if (state.status === 'installing') setState({ status: 'downloaded', message: `Install failed: ${text} The installed version keeps running unchanged.` });
      });
      updater.on('download-progress', (p) => {
        setState({ progress: { percent: Math.max(0, Math.min(100, Math.round(Number(p && p.percent) || 0))), transferred: Number(p && p.transferred) || 0, total: Number(p && p.total) || release.installerSize || 0 } });
      });
      const result = await updater.checkForUpdates();
      const info = result && result.updateInfo;
      const mismatch = checkUpdateInfo(info, release);
      if (mismatch) throw new Error(mismatch);
      if (result.isUpdateAvailable === false) throw new Error(`Version ${release.version} was not accepted as an update.`);

      await updater.downloadUpdate(); // resolves only once the SHA-512 matched
      pending = { release, updater };
      logger.info(`Download completed and verified: ${release.version}.`);
      return { ok: true, ...setState({ status: 'downloaded', progress: { percent: 100 }, message: 'Update downloaded successfully.' }) };
    } catch (err) {
      const problem = describeNetworkError(err);
      const message = problem.status === 'offline' ? problem.message : `Download failed: ${String((err && err.message) || err).slice(0, 200)}`;
      logger.error(`Download of ${release.version} failed: ${String((err && err.message) || err).slice(0, 300)}`);
      return { ok: false, error: 'download_failed', ...setState({ status: 'error', progress: null, message: `${message} The installed version keeps running unchanged.` }) };
    } finally {
      busy = false;
    }
  }

  // What to warn about before closing the app for the installer.
  function installWarning() {
    const now = activity();
    const lines = ['The COM Bridge will close briefly while the update installs.', '', 'Scanners will not be processed during this time.'];
    if (now.connectedScanners > 0) lines.push(`${now.connectedScanners} scanner connection(s) are open now and will be closed.`);
    if (now.printJobsActive > 0) lines.push(`${now.printJobsActive} print job(s) are still being processed - consider waiting for them to finish.`);
    if (pending && pending.release && compareVersions(pending.release.version, currentVersion) < 0) {
      lines.push('', `This installs an OLDER version (${pending.release.version}). Settings are kept, but it may not understand options added in ${currentVersion}.`);
    }
    lines.push('', 'Continue?');
    return { ok: Boolean(pending), message: lines.join('\n'), version: pending ? pending.release.version : null };
  }

  // Only after a verified download AND an explicit confirmed:true from the
  // button's own confirmation dialog.
  function install({ confirmed = false } = {}) {
    if (!pending) return { ok: false, error: 'nothing_downloaded', message: 'Download an update first.' };
    if (confirmed !== true) return { ok: false, error: 'confirmation_required', message: installWarning().message };
    const support = installSupport();
    if (!support.ok) return { ok: false, error: 'unsupported', message: support.reason };
    try {
      logger.info(`Installer launched for ${pending.release.version}; the app is closing to install it.`);
      setState({ status: 'installing', message: 'Closing to install…' });
      // Silent install over the existing installation, then start the app
      // again. The user data folder is not touched by the installer.
      pending.updater.quitAndInstall(true, true);
      return { ok: true };
    } catch (err) {
      logger.error(`Installer could not be started: ${String((err && err.message) || err).slice(0, 300)}`);
      return { ok: false, error: 'install_failed', ...setState({ status: 'downloaded', message: `Install failed: ${String((err && err.message) || err).slice(0, 200)} The installed version keeps running unchanged.` }) };
    }
  }

  function cancelPending() {
    if (!pending) return { ok: true };
    logger.info(`Update to ${pending.release.version} cancelled before installing.`);
    pending = null;
    setState({ status: 'idle', selected: null, progress: null, message: 'Update cancelled.' });
    return { ok: true };
  }

  function getState() {
    const support = installSupport();
    return { ...state, canInstall: support.ok, unsupportedReason: support.ok ? '' : support.reason };
  }

  return { check, listReleases, download, installWarning, install, cancelPending, getState };
}

module.exports = { createUpdateController, describeNetworkError };

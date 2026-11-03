'use strict';

// Which GitHub Releases the Updates tab may offer, and how to tell versions
// apart. No network or Electron here - see update-controller.js for the
// flow and main.js for the real GitHub/electron-updater wiring - so every
// rule below is covered by plain unit tests.
//
// A release is only ever offered if ALL of these hold:
//   - it is published (not a draft) and not a pre-release;
//   - its tag is a plain stable version, vMAJOR.MINOR.PATCH;
//   - it carries the Windows installer this app's build produces
//     (INSTALLER_NAME) AND electron-builder's update metadata (latest.yml);
//   - both download links point at THIS repository's release for THAT tag -
//     nothing from another repository, nothing renamed or relocated.
// The installer itself is never trusted on these grounds alone: electron-
// updater reads that release's latest.yml and checks the downloaded file's
// SHA-512 against it before it can be installed (see update-controller.js).

const nodePath = require('node:path');

const OWNER = 'jamesjhdyer';
const REPO = 'DoorTrackerCOMBridge';
const METADATA_NAME = 'latest.yml';
const MAX_RELEASES = 20;

// Must match package.json's build.nsis.artifactName.
function installerName(version) {
  return `DoorTrackerCOMBridge-Setup-${version}.exe`;
}

// "1.10.0" -> [1, 10, 0]; anything that is not exactly a stable
// MAJOR.MINOR.PATCH (pre-release tags, build metadata, junk) -> null.
function parseVersion(text) {
  const match = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(String(text == null ? '' : text).trim());
  return match ? match.slice(1).map(Number) : null;
}

// Numeric, part by part - 1.10.0 is newer than 1.9.9. Returns -1, 0 or 1.
// Throws on anything that is not a stable version, so a bad value can never
// silently compare as "older" or "newer".
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Not a stable version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function releaseDownloadBase(tag) {
  return `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/`;
}

// The installable stable releases in the GitHub API's /releases answer,
// newest version first (by version number, not by date or by name).
function selectStableReleases(apiReleases) {
  if (!Array.isArray(apiReleases)) return [];
  const seen = new Set();
  const out = [];
  for (const release of apiReleases) {
    if (!release || typeof release !== 'object' || release.draft !== false || release.prerelease !== false) continue;
    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    if (!/^v\d/.test(tag)) continue;
    const parts = parseVersion(tag);
    if (!parts) continue;
    const version = parts.join('.');
    if (seen.has(version)) continue;

    const base = releaseDownloadBase(tag);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = (name) => assets.find((a) => a && a.name === name && a.browser_download_url === `${base}${name}` && a.state !== 'starter');
    const installer = asset(installerName(version));
    const metadata = asset(METADATA_NAME);
    if (!installer || !metadata) continue;

    const notesUrl = typeof release.html_url === 'string' && release.html_url.startsWith(`https://github.com/${OWNER}/${REPO}/releases/`) ? release.html_url : null;
    seen.add(version);
    out.push({
      version,
      tag,
      name: typeof release.name === 'string' ? release.name.slice(0, 120) : tag,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      notesUrl,
      installerName: installer.name,
      installerSize: Number(installer.size) || null,
      feedUrl: base
    });
  }
  out.sort((x, y) => compareVersions(y.version, x.version));
  return out.slice(0, MAX_RELEASES);
}

// What electron-updater read from that release's latest.yml must describe
// exactly the release that was chosen: same version, the expected installer
// file, and a SHA-512 to check the download against. Returns an error
// message, or '' when it matches.
function checkUpdateInfo(updateInfo, release) {
  if (!updateInfo || typeof updateInfo !== 'object') return 'The release has no update information.';
  if (String(updateInfo.version) !== release.version) return `The release's update information is for version ${String(updateInfo.version).slice(0, 20)}, not ${release.version}.`;
  const files = Array.isArray(updateInfo.files) ? updateInfo.files : [];
  if (files.length !== 1) return 'The release\'s update information does not name exactly one installer.';
  const file = files[0];
  if (!file || file.url !== release.installerName) return 'The release\'s update information names a different installer file.';
  if (typeof file.sha512 !== 'string' || file.sha512.length < 80) return 'The release\'s update information has no SHA-512 checksum.';
  return '';
}

// True when `child` is `parent` itself or somewhere inside it.
function isPathInside(child, parent, pathModule = nodePath) {
  const relative = pathModule.relative(pathModule.resolve(parent), pathModule.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !pathModule.isAbsolute(relative));
}

// GET /repos/{owner}/{repo}/releases - public, so no token is ever sent.
async function fetchReleases(fetchImpl = fetch, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=50`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DoorTrackerCOMBridge-Updater', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: controller.signal
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub answered ${response.status}`), { status: response.status });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { OWNER, REPO, METADATA_NAME, MAX_RELEASES, installerName, parseVersion, compareVersions, releaseDownloadBase, selectStableReleases, checkUpdateInfo, isPathInside, fetchReleases };

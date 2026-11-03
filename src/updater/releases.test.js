'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');

const releases = require('./releases');
const { compareVersions, parseVersion, selectStableReleases, checkUpdateInfo, isPathInside, installerName, fetchReleases } = releases;

const BASE = 'https://github.com/jamesjhdyer/DoorTrackerCOMBridge/releases/download';

// One GitHub API release object, as /repos/{owner}/{repo}/releases returns it.
function apiRelease(version, overrides = {}) {
  const tag = overrides.tag || `v${version}`;
  const asset = (name, url = `${BASE}/${tag}/${name}`) => ({ name, browser_download_url: url, size: 90_000_000, state: 'uploaded' });
  return {
    tag_name: tag,
    name: `Door Tracker COM Bridge ${version}`,
    draft: false,
    prerelease: false,
    published_at: '2026-11-03T10:00:00Z',
    html_url: `https://github.com/jamesjhdyer/DoorTrackerCOMBridge/releases/tag/${tag}`,
    assets: overrides.assets || [asset(installerName(version)), asset(`${installerName(version)}.blockmap`), asset('latest.yml'), asset(`DoorTrackerCOMBridge-Portable-${version}.exe`)],
    ...overrides.fields
  };
}

test('versions compare numerically, part by part - never alphabetically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.9.9', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('v1.3.0', '1.3.0'), 0);
  assert.equal(compareVersions('1.3.0', '1.3.0'), 0);
  assert.throws(() => compareVersions('1.3.0-beta.1', '1.3.0'));
  assert.throws(() => compareVersions('latest', '1.3.0'));
  for (const bad of ['1.3', '1.3.0.1', '01.3.0', '1.3.0+build', '', null, 'v1.3.x']) assert.equal(parseVersion(bad), null, String(bad));
});

test('only published, non-prerelease, stable-tagged releases are offered, newest version first', () => {
  const list = selectStableReleases([
    apiRelease('1.2.0'),
    apiRelease('1.10.0'),
    apiRelease('1.9.9'),
    apiRelease('1.11.0', { fields: { draft: true } }),
    apiRelease('1.12.0', { fields: { prerelease: true } }),
    apiRelease('1.13.0-beta.1'),
    apiRelease('1.3.0', { tag: 'nightly' })
  ]);
  assert.deepEqual(list.map((r) => r.version), ['1.10.0', '1.9.9', '1.2.0']);
  assert.equal(list[0].feedUrl, `${BASE}/v1.10.0/`);
  assert.equal(list[0].installerName, 'DoorTrackerCOMBridge-Setup-1.10.0.exe');
});

test('a release whose assets point at another repository is rejected', () => {
  const other = 'https://github.com/someone-else/DoorTrackerCOMBridge/releases/download/v1.3.0';
  const list = selectStableReleases([
    apiRelease('1.3.0', { assets: [{ name: installerName('1.3.0'), browser_download_url: `${other}/${installerName('1.3.0')}` }, { name: 'latest.yml', browser_download_url: `${other}/latest.yml` }] }),
    apiRelease('1.2.9', { assets: [{ name: installerName('1.2.9'), browser_download_url: `https://evil.example.com/${installerName('1.2.9')}` }, { name: 'latest.yml', browser_download_url: `${BASE}/v1.2.9/latest.yml` }] }),
    apiRelease('1.2.8', { assets: [{ name: installerName('1.2.8'), browser_download_url: `${BASE}/v1.2.7/${installerName('1.2.8')}` }, { name: 'latest.yml', browser_download_url: `${BASE}/v1.2.8/latest.yml` }] })
  ]);
  assert.deepEqual(list, []);
});

test('a release without the Windows installer and its update metadata is rejected (wrong platform / incomplete)', () => {
  const asset = (tag, name) => ({ name, browser_download_url: `${BASE}/${tag}/${name}` });
  const list = selectStableReleases([
    apiRelease('1.3.0', { assets: [asset('v1.3.0', 'DoorTrackerCOMBridge-1.3.0.dmg'), asset('v1.3.0', 'latest-mac.yml')] }),
    apiRelease('1.2.9', { assets: [asset('v1.2.9', 'DoorTrackerCOMBridge-Portable-1.2.9.exe'), asset('v1.2.9', 'latest.yml')] }),
    apiRelease('1.2.8', { assets: [asset('v1.2.8', installerName('1.2.8'))] }),
    apiRelease('1.2.7', { assets: [asset('v1.2.7', installerName('1.2.6')), asset('v1.2.7', 'latest.yml')] }),
    apiRelease('1.2.5')
  ]);
  assert.deepEqual(list.map((r) => r.version), ['1.2.5']);
});

test('garbage from the API never throws and yields nothing', () => {
  assert.deepEqual(selectStableReleases(null), []);
  assert.deepEqual(selectStableReleases({ message: 'Not Found' }), []);
  assert.deepEqual(selectStableReleases([null, 1, 'x', {}, { tag_name: 'v1.0.0', draft: false, prerelease: false }]), []);
});

test('the release list is capped and de-duplicated', () => {
  const many = Array.from({ length: 30 }, (_, i) => apiRelease(`1.${i}.0`));
  const list = selectStableReleases([...many, apiRelease('1.29.0')]);
  assert.equal(list.length, releases.MAX_RELEASES);
  assert.equal(list[0].version, '1.29.0');
  assert.equal(new Set(list.map((r) => r.version)).size, list.length);
});

test('the downloaded update metadata must describe exactly the chosen release', () => {
  const [release] = selectStableReleases([apiRelease('1.3.0')]);
  const good = { version: '1.3.0', files: [{ url: 'DoorTrackerCOMBridge-Setup-1.3.0.exe', sha512: 'x'.repeat(88), size: 1 }], path: 'DoorTrackerCOMBridge-Setup-1.3.0.exe' };
  assert.equal(checkUpdateInfo(good, release), '');
  assert.match(checkUpdateInfo({ ...good, version: '1.2.0' }, release), /not 1\.3\.0/);
  assert.match(checkUpdateInfo({ ...good, files: [{ ...good.files[0], url: 'https://evil.example.com/x.exe' }] }, release), /different installer/);
  assert.match(checkUpdateInfo({ ...good, files: [{ ...good.files[0], sha512: '' }] }, release), /SHA-512/);
  assert.match(checkUpdateInfo({ ...good, files: [] }, release), /exactly one/);
  assert.match(checkUpdateInfo(null, release), /no update information/);
});

test('isPathInside tells whether settings would sit inside the program folder', () => {
  const win = nodePath.win32;
  assert.equal(isPathInside('C:\\Users\\shop\\AppData\\Roaming\\Door Tracker COM Bridge', 'C:\\Users\\shop\\AppData\\Local\\Programs\\door-tracker-com-bridge', win), false);
  assert.equal(isPathInside('C:\\Apps\\Bridge\\data', 'C:\\Apps\\Bridge', win), true);
  assert.equal(isPathInside('C:\\Apps\\Bridge', 'C:\\Apps\\Bridge', win), true);
  assert.equal(isPathInside('C:\\Apps\\Bridge2', 'C:\\Apps\\Bridge', win), false);
});

test('fetchReleases asks the public GitHub API for this repository with no credentials', async () => {
  let seen = null;
  const fakeFetch = async (url, options) => {
    seen = { url, options };
    return { ok: true, json: async () => [apiRelease('1.3.0')] };
  };
  const json = await fetchReleases(fakeFetch);
  assert.equal(json.length, 1);
  assert.match(seen.url, /^https:\/\/api\.github\.com\/repos\/jamesjhdyer\/DoorTrackerCOMBridge\/releases\b/);
  assert.equal(Object.keys(seen.options.headers).some((h) => h.toLowerCase() === 'authorization'), false);

  await assert.rejects(fetchReleases(async () => ({ ok: false, status: 403 })), (err) => err.status === 403);
});

// The COM Bridge's own settings file (settings.json in Electron's userData
// folder): the shared website address and one entry per connection tab.
//
// The ONE place that file is read and written - the Windows app's tabs (via
// main.js's save-settings handler) and Remote Admin (via
// remote-admin/actions.js) both come through here, so there is no second
// configuration implementation. Edits made one connection at a time
// (updateConnection/addConnection/removeConnection - what Remote Admin uses)
// are checked with com-options.js's validateConnectionSettings, the same
// station/baud list the Windows app's own dropdowns are built from.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DEFAULT_BAUD_RATE, validateConnectionSettings } = require('./com-options');

const MAX_CONNECTIONS = 32;

function defaultSettings() {
  return {
    apiUrl: '',
    tabs: [
      { id: randomUUID(), comPort: 'COM5', baudRate: DEFAULT_BAUD_RATE, stationKey: 'frame_cutting' }
    ]
  };
}

// Accepts either the current { apiUrl, tabs: [...] } shape or the older
// single-connection { comPort, baudRate, stationKey, apiUrl } shape so
// existing settings.json files on disk still load correctly.
function normalizeSettings(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return defaultSettings();
  }

  if (!Array.isArray(parsed.tabs)) {
    const fallback = defaultSettings().tabs[0];
    return {
      apiUrl: parsed.apiUrl || '',
      tabs: [
        {
          id: randomUUID(),
          comPort: parsed.comPort || fallback.comPort,
          baudRate: parsed.baudRate || fallback.baudRate,
          stationKey: parsed.stationKey || fallback.stationKey
        }
      ]
    };
  }

  return {
    apiUrl: parsed.apiUrl || '',
    tabs: parsed.tabs.length > 0 ? parsed.tabs : defaultSettings().tabs
  };
}

function loadSettings(filePath) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return normalizeSettings(null);
  }
}

// Written to a temporary file and renamed into place, so a crash (or the
// Windows app and Remote Admin saving at nearly the same moment) can never
// leave a half-written settings.json behind.
function saveSettings(filePath, settings) {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(temp, filePath);
  return normalized;
}

// The edits below each return { ok: true, settings, tab } with a NEW
// settings object (the input is never modified) or { ok: false, errors }.
// Nothing is written to disk here - the caller saves with saveSettings().

function findTab(settings, tabId) {
  return settings.tabs.find((tab) => tab.id === tabId) || null;
}

// A COM port may only be assigned to one connection - two tabs on the same
// port could never both open it.
function portInUseError(settings, comPort, exceptTabId) {
  const other = settings.tabs.find((tab) => tab.id !== exceptTabId && String(tab.comPort || '').toUpperCase() === comPort.toUpperCase());
  return other ? [`${comPort} is already assigned to another connection.`] : [];
}

function updateConnection(settings, tabId, patch, options = {}) {
  const current = findTab(settings, tabId);
  if (!current) return { ok: false, errors: ['That connection no longer exists.'] };

  const merged = { comPort: current.comPort, baudRate: current.baudRate, stationKey: current.stationKey, ...pickConnectionFields(patch) };
  const result = validateConnectionSettings(merged, options);
  if (!result.ok) return result;
  const clash = portInUseError(settings, result.value.comPort, tabId);
  if (clash.length > 0) return { ok: false, errors: clash };

  const tab = { ...current, ...result.value };
  return { ok: true, tab, settings: { ...settings, tabs: settings.tabs.map((t) => (t.id === tabId ? tab : t)) } };
}

function addConnection(settings, fields, options = {}) {
  if (settings.tabs.length >= MAX_CONNECTIONS) return { ok: false, errors: [`At most ${MAX_CONNECTIONS} connections can be set up.`] };
  const result = validateConnectionSettings(pickConnectionFields(fields), options);
  if (!result.ok) return result;
  const clash = portInUseError(settings, result.value.comPort, null);
  if (clash.length > 0) return { ok: false, errors: clash };

  const tab = { id: randomUUID(), ...result.value };
  return { ok: true, tab, settings: { ...settings, tabs: [...settings.tabs, tab] } };
}

function removeConnection(settings, tabId) {
  const current = findTab(settings, tabId);
  if (!current) return { ok: false, errors: ['That connection no longer exists.'] };
  if (settings.tabs.length === 1) return { ok: false, errors: ['The last connection cannot be removed - change its settings instead.'] };
  return { ok: true, tab: current, settings: { ...settings, tabs: settings.tabs.filter((t) => t.id !== tabId) } };
}

// Only these three are ever taken from an edit - never an id, never apiUrl.
function pickConnectionFields(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const name of ['comPort', 'baudRate', 'stationKey']) {
    if (raw[name] !== undefined) out[name] = raw[name];
  }
  return out;
}

module.exports = { MAX_CONNECTIONS, defaultSettings, normalizeSettings, loadSettings, saveSettings, findTab, updateConnection, addConnection, removeConnection };

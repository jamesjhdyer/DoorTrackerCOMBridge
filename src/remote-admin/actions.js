'use strict';

// The complete list of things Remote Admin can ask the COM Bridge to do, and
// the main-process code that does them. This is the trust boundary: the
// Remote Admin process (admin-entry.js/admin-server.js) can only name one of
// ACTION_NAMES and pass plain parameters; everything is validated again here
// before main.js's own functions are called. There is deliberately no action
// that sends bytes to a serial port, runs a program, or touches any file other
// than the COM settings (through com-settings.js - the same code the Windows
// app's tabs save through).
//
// Actions that could interrupt scanning on the shop floor (disconnecting or
// reconnecting a working scanner, changing a COM port, removing a
// connection, restarting all scanners) are refused with
// 'confirmation_required' unless the request says confirm: true - the admin
// page asks the person first, and a request that skipped the page's question
// still cannot do it by accident.

const comSettings = require('../com-settings');
const { STATION_GROUPS, STATIONS, BAUD_RATES } = require('../com-options');

const ACTION_NAMES = Object.freeze([
  'get-state',
  'list-ports',
  'connect',
  'disconnect',
  'reconnect',
  'restart-all',
  'update-connection',
  'add-connection',
  'remove-connection'
]);

const STATION_LABELS = new Map(STATIONS.map((s) => [s.key, s.label]));

function fail(error, message, extra = {}) {
  return { ok: false, error, message, ...extra };
}

function needsConfirmation(message) {
  return fail('confirmation_required', message);
}

// deps (all supplied by main.js):
//   loadSettings()                  -> { apiUrl, tabs }
//   saveSettings(settings)          -> saved settings (also tells the Windows app's window)
//   listPorts()                     -> Promise<[{ path, manufacturer }]>
//   connectionState(tabId)          -> { connected, status, message, lastScanAt, lastScanValue, lastError, lastErrorAt }
//   openConnection(tab, apiUrl)     -> Promise<{ ok, error? }>
//   closeConnection(tabId)          -> Promise<{ ok, error? }>
//   platform                        -> optional, for the automated tests (see com-options.js)
function createAdminActions(deps) {
  const validationOptions = deps.platform ? { platform: deps.platform } : {};
  // One change at a time, in the order asked: two quick clicks on Reconnect
  // can never interleave a close and an open on the same port.
  let queue = Promise.resolve();
  const serialized = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  function describeTab(tab) {
    return `${tab.comPort || '(no port)'} (${STATION_LABELS.get(tab.stationKey) || tab.stationKey || 'no station'})`;
  }

  function scannerView(tab) {
    const live = deps.connectionState(tab.id) || {};
    const state = live.connected ? 'connected' : live.status === 'error' ? 'error' : 'disconnected';
    return {
      id: tab.id,
      comPort: tab.comPort || '',
      baudRate: tab.baudRate,
      stationKey: tab.stationKey,
      stationLabel: STATION_LABELS.get(tab.stationKey) || tab.stationKey || '',
      state,
      message: live.message || '',
      lastScanAt: live.lastScanAt || null,
      lastScanValue: live.lastScanValue || null,
      lastError: live.lastError || null,
      lastErrorAt: live.lastErrorAt || null
    };
  }

  function getTab(params) {
    const tabId = params && typeof params.tabId === 'string' && params.tabId.length <= 100 ? params.tabId : '';
    return tabId ? comSettings.findTab(deps.loadSettings(), tabId) : null;
  }

  async function reopen(tab) {
    const closed = await deps.closeConnection(tab.id);
    if (!closed.ok) return closed;
    return deps.openConnection(tab, deps.loadSettings().apiUrl);
  }

  const handlers = {
    'get-state': async () => {
      const scanners = deps.loadSettings().tabs.map(scannerView);
      const lastScan = scanners.filter((s) => s.lastScanAt).sort((a, b) => b.lastScanAt.localeCompare(a.lastScanAt))[0];
      return {
        ok: true,
        result: {
          generatedAt: new Date().toISOString(),
          summary: {
            total: scanners.length,
            connected: scanners.filter((s) => s.state === 'connected').length,
            errors: scanners.filter((s) => s.state === 'error').length
          },
          lastScan: lastScan ? { comPort: lastScan.comPort, stationLabel: lastScan.stationLabel, value: lastScan.lastScanValue, at: lastScan.lastScanAt } : null,
          scanners,
          options: { stationGroups: STATION_GROUPS, baudRates: BAUD_RATES }
        }
      };
    },

    'list-ports': async () => {
      const ports = await deps.listPorts();
      return { ok: true, result: { ports: ports.map((p) => ({ path: String(p.path), manufacturer: String(p.manufacturer || '') })) } };
    },

    connect: async (params) => {
      const tab = getTab(params);
      if (!tab) return fail('not_found', 'That connection no longer exists.');
      if (deps.connectionState(tab.id)?.connected) return fail('already_connected', `${tab.comPort} is already connected.`);
      const result = await deps.openConnection(tab, deps.loadSettings().apiUrl);
      return result.ok ? { ok: true, result: { audit: describeTab(tab) } } : fail('connect_failed', `Could not connect ${tab.comPort}: ${result.error}`);
    },

    disconnect: async (params) => {
      const tab = getTab(params);
      if (!tab) return fail('not_found', 'That connection no longer exists.');
      if (!params.confirm) return needsConfirmation(`Disconnect ${describeTab(tab)}? Scans at that station will stop until it is reconnected.`);
      const result = await deps.closeConnection(tab.id);
      return result.ok ? { ok: true, result: { audit: describeTab(tab) } } : fail('disconnect_failed', `Could not disconnect ${tab.comPort}: ${result.error}`);
    },

    // Reconnecting a port that is down needs no confirmation; one that is
    // working does (it is briefly interrupted).
    reconnect: async (params) => {
      const tab = getTab(params);
      if (!tab) return fail('not_found', 'That connection no longer exists.');
      if (deps.connectionState(tab.id)?.connected && !params.confirm) return needsConfirmation(`${describeTab(tab)} is working. Reconnect it anyway? Scanning there pauses for a moment.`);
      const result = await reopen(tab);
      return result.ok ? { ok: true, result: { audit: describeTab(tab) } } : fail('connect_failed', `Could not reconnect ${tab.comPort}: ${result.error}`);
    },

    // "Restart scanner subsystem": closes and reopens every connection that
    // is connected or has failed. Connections deliberately left disconnected
    // stay that way.
    'restart-all': async (params) => {
      const tabs = deps.loadSettings().tabs.filter((tab) => {
        const live = deps.connectionState(tab.id) || {};
        return live.connected || live.status === 'error';
      });
      if (!params.confirm) return needsConfirmation(`Restart all ${tabs.length} active scanner connection(s)? Every station pauses for a moment.`);
      const results = [];
      for (const tab of tabs) {
        const outcome = await reopen(tab);
        results.push({ id: tab.id, comPort: tab.comPort, ok: outcome.ok, error: outcome.ok ? undefined : outcome.error });
      }
      const failed = results.filter((r) => !r.ok);
      return { ok: true, result: { results, audit: `restarted=${results.length - failed.length} failed=${failed.length}` } };
    },

    // Saves through com-settings.js, then - only if this one connection was
    // open - reopens just it with the new settings. Every other connection
    // is left exactly as it was.
    'update-connection': async (params) => {
      const settings = deps.loadSettings();
      const current = comSettings.findTab(settings, typeof params.tabId === 'string' ? params.tabId : '');
      if (!current) return fail('not_found', 'That connection no longer exists.');
      const edit = comSettings.updateConnection(settings, current.id, params, validationOptions);
      if (!edit.ok) return fail('invalid', edit.errors.join(' '), { errors: edit.errors });

      const changed = ['comPort', 'baudRate', 'stationKey'].filter((name) => edit.tab[name] !== current[name]);
      if (changed.length === 0) return { ok: true, result: { changed: [], reconnected: false, audit: `${describeTab(current)} unchanged` } };

      const wasConnected = Boolean(deps.connectionState(current.id)?.connected);
      if (!params.confirm && (changed.includes('comPort') || wasConnected)) {
        return needsConfirmation(`Change ${describeTab(current)} to ${describeTab(edit.tab)}?${wasConnected ? ' It is connected now and will be reconnected with the new settings.' : ''}`);
      }

      let connectResult = null;
      if (wasConnected) {
        const closed = await deps.closeConnection(current.id);
        if (!closed.ok) return fail('disconnect_failed', `Settings not changed - could not disconnect ${current.comPort}: ${closed.error}`);
      }
      deps.saveSettings(edit.settings);
      if (wasConnected) connectResult = await deps.openConnection(edit.tab, edit.settings.apiUrl);

      const audit = `${describeTab(current)} -> ${describeTab(edit.tab)} changed=${changed.join(',')}`;
      if (connectResult && !connectResult.ok) {
        return fail('connect_failed', `Settings saved, but ${edit.tab.comPort} could not be reconnected: ${connectResult.error}`);
      }
      return { ok: true, result: { changed, reconnected: wasConnected, audit } };
    },

    'add-connection': async (params) => {
      const edit = comSettings.addConnection(deps.loadSettings(), params, validationOptions);
      if (!edit.ok) return fail('invalid', edit.errors.join(' '), { errors: edit.errors });
      deps.saveSettings(edit.settings);
      return { ok: true, result: { id: edit.tab.id, audit: `added ${describeTab(edit.tab)}` } };
    },

    'remove-connection': async (params) => {
      const tab = getTab(params);
      if (!tab) return fail('not_found', 'That connection no longer exists.');
      const edit = comSettings.removeConnection(deps.loadSettings(), tab.id);
      if (!edit.ok) return fail('invalid', edit.errors.join(' '), { errors: edit.errors });
      if (!params.confirm) return needsConfirmation(`Remove the ${describeTab(tab)} connection?${deps.connectionState(tab.id)?.connected ? ' It will be disconnected.' : ''}`);
      if (deps.connectionState(tab.id)?.connected) {
        const closed = await deps.closeConnection(tab.id);
        if (!closed.ok) return fail('disconnect_failed', `Not removed - could not disconnect ${tab.comPort}: ${closed.error}`);
      }
      deps.saveSettings(edit.settings);
      return { ok: true, result: { audit: `removed ${describeTab(tab)}` } };
    }
  };

  const READ_ONLY = new Set(['get-state', 'list-ports']);

  // Always answers { ok: true, result } or { ok: false, error, message } -
  // never throws.
  async function handle(action, params) {
    if (!ACTION_NAMES.includes(action)) return fail('unknown_action', 'Unknown action.');
    const safeParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    const run = async () => {
      try {
        return await handlers[action](safeParams);
      } catch (err) {
        return fail('failed', (err && err.message) || 'The action failed.');
      }
    };
    return READ_ONLY.has(action) ? run() : serialized(run);
  }

  return { handle };
}

module.exports = { ACTION_NAMES, createAdminActions };

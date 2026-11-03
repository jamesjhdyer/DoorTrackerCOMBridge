// The Remote Admin page. Talks only to its own server's /admin/api/...
// routes (see admin-server.js). Every state-changing request carries the
// session's CSRF token; anything that could interrupt scanning is first
// refused by the server with 'confirmation_required', shown to the person
// with the server's own wording, and only resent with confirm: true if they
// agree. Everything shown is put on the page as text, never as HTML.
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const STATE_POLL_MS = 5000;
  const LOGS_POLL_MS = 15000;

  let csrfToken = '';
  let options = { stationGroups: [], baudRates: [] };
  let scanners = [];
  let availablePorts = [];
  let editing = null; // { mode: 'edit'|'add', tabId? }
  let stateTimer = null;
  let logsTimer = null;

  const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateTimeFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function formatTime(iso) {
    if (!iso) return '-';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dateTimeFormat.format(date);
  }

  // ---- Talking to the server ----

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.message) || `Request failed (${status}).`);
      this.status = status;
      this.code = body && body.error;
    }
  }

  async function api(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }
    const response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try {
      data = await response.json();
    } catch {
      // not JSON
    }
    if (response.status === 401 && path !== '/admin/api/login') {
      showLogin('Your session has ended. Please sign in again.');
      throw new ApiError(401, data);
    }
    if (!response.ok) throw new ApiError(response.status, data);
    return data;
  }

  // Runs one action; if the server asks for confirmation, asks the person
  // with the server's own message and only then sends it again confirmed.
  async function runAction(action, params, successText) {
    try {
      let reply;
      try {
        reply = await api('POST', '/admin/api/action', { action, params });
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'confirmation_required') throw err;
        if (!window.confirm(err.message)) return null;
        reply = await api('POST', '/admin/api/action', { action, params, confirm: true });
      }
      showMessage(successText || 'Done.');
      return reply.result;
    } catch (err) {
      if (err.status !== 401) showMessage(err.message, true);
      return null;
    } finally {
      refreshState();
    }
  }

  function showMessage(text, isError) {
    const el = $('message');
    el.textContent = text;
    el.classList.toggle('is-error', Boolean(isError));
    el.hidden = false;
    clearTimeout(showMessage.timer);
    showMessage.timer = setTimeout(() => (el.hidden = true), isError ? 15000 : 6000);
  }

  // ---- Sign in / out ----

  function showLogin(note) {
    csrfToken = '';
    clearInterval(stateTimer);
    clearInterval(logsTimer);
    $('app-view').hidden = true;
    $('logout-btn').hidden = true;
    $('login-view').hidden = false;
    if (note) $('login-note').textContent = note;
    $('login-password').focus();
  }

  function showApp() {
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('logout-btn').hidden = false;
    refreshState();
    refreshLogs();
    clearInterval(stateTimer);
    clearInterval(logsTimer);
    stateTimer = setInterval(() => !document.hidden && refreshState(), STATE_POLL_MS);
    logsTimer = setInterval(() => !document.hidden && refreshLogs(), LOGS_POLL_MS);
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('login-error');
    error.hidden = true;
    $('login-btn').disabled = true;
    try {
      const reply = await api('POST', '/admin/api/login', { password: $('login-password').value });
      csrfToken = reply.csrfToken;
      $('login-password').value = '';
      showApp();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      $('login-btn').disabled = false;
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/admin/api/logout', {});
    } catch {
      // signed out either way
    }
    showLogin('Signed out.');
  });

  // ---- Status display ----

  const STATE_LABELS = {
    connected: { cls: 'status-ok', text: '● Connected' },
    error: { cls: 'status-bad', text: '✕ Error' },
    disconnected: { cls: 'status-off', text: '○ Disconnected' }
  };

  function statusChip(cls, text) {
    const span = document.createElement('span');
    span.className = `status ${cls}`;
    span.textContent = text;
    return span;
  }

  function renderOverview(state) {
    const { summary, lastScan } = state;
    const service = $('ov-service');
    service.textContent = '';
    if (summary.total === 0) service.appendChild(statusChip('status-off', '○ No connections set up'));
    else if (summary.connected === summary.total) service.appendChild(statusChip('status-ok', '● Running'));
    else if (summary.connected > 0) service.appendChild(statusChip('status-warn', '▲ Running (some scanners down)'));
    else service.appendChild(statusChip('status-bad', '✕ No scanners connected'));

    $('ov-connected').textContent = `${summary.connected} / ${summary.total}`;
    $('ov-errors').textContent = summary.errors === 0 ? 'None' : String(summary.errors);
    $('ov-last-scan').textContent = lastScan ? `${lastScan.value}  ·  ${formatTime(lastScan.at)}  ·  ${lastScan.comPort} (${lastScan.stationLabel})` : 'No scans since the app started';
    $('ov-updated').textContent = formatTime(state.generatedAt);
  }

  function button(text, onClick, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `small${extraClass ? ` ${extraClass}` : ''}`;
    b.textContent = text;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await onClick();
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  function renderScanners() {
    const body = $('scanners-body');
    body.textContent = '';
    if (scanners.length === 0) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 7;
      cell.textContent = 'No connections set up.';
      return;
    }
    for (const s of scanners) {
      const row = body.insertRow();
      const port = row.insertCell();
      port.className = 'mono';
      port.textContent = s.comPort || '-';
      row.insertCell().textContent = s.stationLabel || '-';
      row.insertCell().textContent = String(s.baudRate || '-');
      const label = STATE_LABELS[s.state] || STATE_LABELS.disconnected;
      row.insertCell().appendChild(statusChip(label.cls, label.text));
      const last = row.insertCell();
      if (s.lastScanValue) {
        const value = document.createElement('div');
        value.className = 'mono';
        value.textContent = s.lastScanValue;
        const at = document.createElement('div');
        at.className = 'hint';
        at.textContent = formatTime(s.lastScanAt);
        last.append(value, at);
      } else {
        last.textContent = '-';
      }
      const error = row.insertCell();
      error.textContent = s.lastError ? `${s.lastError} (${formatTime(s.lastErrorAt)})` : '-';

      const actions = row.insertCell();
      actions.className = 'actions';
      if (s.state === 'connected') {
        actions.append(
          button('Reconnect', () => runAction('reconnect', { tabId: s.id }, `${s.comPort} reconnected.`)),
          button('Disconnect', () => runAction('disconnect', { tabId: s.id }, `${s.comPort} disconnected.`), 'danger')
        );
      } else {
        actions.append(button(s.state === 'error' ? 'Reconnect' : 'Connect', () => runAction(s.state === 'error' ? 'reconnect' : 'connect', { tabId: s.id }, `${s.comPort} connected.`)));
      }
      actions.append(
        button('Edit', () => openEditor({ mode: 'edit', tabId: s.id })),
        button('Remove', () => runAction('remove-connection', { tabId: s.id }, `${s.comPort} removed.`), 'danger')
      );
    }
  }

  async function refreshState() {
    try {
      const reply = await api('GET', '/admin/api/state');
      const state = reply.result;
      options = state.options;
      scanners = state.scanners;
      renderOverview(state);
      renderScanners();
    } catch (err) {
      if (err.status !== 401) showMessage(`Could not load status: ${err.message}`, true);
    }
  }

  // ---- Ports ----

  async function refreshPorts() {
    try {
      const reply = await api('GET', '/admin/api/ports');
      availablePorts = reply.result.ports;
      $('ports-line').textContent = availablePorts.length
        ? `Available COM ports: ${availablePorts.map((p) => (p.manufacturer ? `${p.path} (${p.manufacturer})` : p.path)).join(', ')}`
        : 'Available COM ports: none found';
    } catch (err) {
      if (err.status !== 401) showMessage(`Could not list ports: ${err.message}`, true);
    }
  }

  $('refresh-ports-btn').addEventListener('click', refreshPorts);
  $('restart-all-btn').addEventListener('click', async () => {
    const result = await runAction('restart-all', {}, 'Scanner subsystem restarted.');
    if (result && result.results) {
      const failed = result.results.filter((r) => !r.ok);
      if (failed.length > 0) showMessage(`Restarted, but ${failed.map((f) => `${f.comPort}: ${f.error}`).join('; ')}`, true);
    }
  });

  // ---- Edit / add ----

  function fillSelect(select, items, value) {
    select.textContent = '';
    for (const item of items) {
      if (item.group) {
        const group = document.createElement('optgroup');
        group.label = item.group;
        for (const option of item.options) group.appendChild(new Option(option.label, option.value));
        select.appendChild(group);
      } else {
        select.appendChild(new Option(item.label, item.value));
      }
    }
    if (value !== undefined) select.value = String(value);
  }

  async function openEditor(mode) {
    await refreshPorts();
    editing = mode;
    const current = mode.mode === 'edit' ? scanners.find((s) => s.id === mode.tabId) : null;
    if (mode.mode === 'edit' && !current) return;

    const portPaths = availablePorts.map((p) => p.path);
    if (current && current.comPort && !portPaths.includes(current.comPort)) portPaths.unshift(current.comPort);
    fillSelect($('edit-port'), portPaths.map((p) => ({ label: p, value: p })), current ? current.comPort : portPaths[0]);
    fillSelect($('edit-station'), options.stationGroups.map((g) => ({ group: g.group, options: g.stations.map((s) => ({ label: s.label, value: s.key })) })), current ? current.stationKey : undefined);
    fillSelect($('edit-baud'), options.baudRates.map((b) => ({ label: String(b), value: b })), current ? current.baudRate : 19200);

    $('edit-title').textContent = current ? `Edit ${current.comPort} (${current.stationLabel})` : 'Add a connection';
    $('edit-error').hidden = true;
    $('edit-form').hidden = false;
    $('edit-port').focus();
  }

  function closeEditor() {
    editing = null;
    $('edit-form').hidden = true;
  }

  $('add-btn').addEventListener('click', () => openEditor({ mode: 'add' }));
  $('edit-cancel').addEventListener('click', closeEditor);
  $('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!editing) return;
    const fields = { comPort: $('edit-port').value, stationKey: $('edit-station').value, baudRate: Number($('edit-baud').value) };
    if (!fields.comPort) {
      $('edit-error').textContent = 'Choose a COM port (press Refresh ports if it is not listed).';
      $('edit-error').hidden = false;
      return;
    }
    $('edit-save').disabled = true;
    try {
      const action = editing.mode === 'edit' ? 'update-connection' : 'add-connection';
      const params = editing.mode === 'edit' ? { tabId: editing.tabId, ...fields } : fields;
      const result = await runAction(action, params, editing.mode === 'edit' ? 'Connection settings saved.' : `Connection on ${fields.comPort} added - press Connect to start it.`);
      if (result) {
        if (result.reconnected) showMessage('Connection settings saved and the connection was reconnected.');
        closeEditor();
      }
    } finally {
      $('edit-save').disabled = false;
    }
  });

  // ---- Logs ----

  async function refreshLogs() {
    const source = $('log-source').value;
    const limit = $('log-limit').value;
    try {
      const reply = await api('GET', `/admin/api/logs?source=${encodeURIComponent(source)}&limit=${encodeURIComponent(limit)}`);
      const body = $('logs-body');
      body.textContent = '';
      if (reply.entries.length === 0) {
        const cell = body.insertRow().insertCell();
        cell.colSpan = 4;
        cell.textContent = 'No log entries yet.';
        return;
      }
      for (const entry of reply.entries) {
        const row = body.insertRow();
        row.insertCell().textContent = formatTime(entry.timestamp);
        const level = row.insertCell();
        level.className = `level-${entry.level}`;
        level.textContent = entry.level === 'ERROR' ? '✕ ERROR' : entry.level === 'WARN' ? '▲ WARN' : 'INFO';
        row.insertCell().textContent = entry.component === 'com-bridge' ? 'COM Bridge' : 'Remote Admin';
        row.insertCell().textContent = entry.message;
      }
    } catch (err) {
      if (err.status !== 401) showMessage(`Could not load logs: ${err.message}`, true);
    }
  }

  $('logs-refresh-btn').addEventListener('click', refreshLogs);
  $('log-source').addEventListener('change', refreshLogs);
  $('log-limit').addEventListener('change', refreshLogs);

  // ---- Start ----

  (async function init() {
    try {
      const session = await api('GET', '/admin/api/session');
      if (session.authenticated) {
        csrfToken = session.csrfToken;
        showApp();
      } else {
        showLogin(session.passwordSet === false ? 'No admin password has been set yet - set one in the COM Bridge app on the workshop PC (Remote Admin tab).' : undefined);
      }
    } catch {
      showLogin('Could not reach the COM Bridge.');
    }
  })();
})();

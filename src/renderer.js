const STATION_GROUPS = [
  {
    group: 'Doors',
    stations: [
      { key: 'door_cutting', label: 'Door Cut' },
      { key: 'lipping_edging', label: 'Door Lipping' },
      { key: 'door_press', label: 'Door Press' },
      { key: 'door_machining', label: 'Door CNC' },
      { key: 'spray_finishing', label: 'Door Spray' },
      { key: 'door_bench', label: 'Door Bench' }
    ]
  },
  {
    group: 'Frames',
    stations: [
      { key: 'frame_cutting', label: 'Frame Cut & Mould' },
      { key: 'frame_cut_to_size', label: 'Frame Cut To Size' },
      { key: 'frame_machining', label: 'Frame CNC' },
      { key: 'frame_sanding', label: 'Frame Sand' },
      { key: 'frame_finish', label: 'Frame Spray' }
    ]
  },
  {
    group: 'Joint Station',
    stations: [
      { key: 'joint_assembly', label: 'Assembly' },
      { key: 'joint_prehung', label: 'Pre-Hung' }
    ]
  }
];

const STATIONS = STATION_GROUPS.flatMap((g) => g.stations);
const STATION_LABELS = new Map(STATIONS.map((s) => [s.key, s.label]));

const RECENT_SCANS_LIMIT = 50;
const SAVE_DEBOUNCE_MS = 400;

// ---- Static DOM refs ----

const apiUrlInput = document.getElementById('api-url-input');
const apiUrlSavedFlash = document.getElementById('api-url-saved');
const tabBar = document.getElementById('tab-bar');
const addTabBtn = document.getElementById('add-tab-btn');
const tabPanelsContainer = document.getElementById('tab-panels');
const tabTemplate = document.getElementById('tab-panel-template');
const dashboardPanel = document.getElementById('panel-dashboard');
const connectionsBody = document.getElementById('connections-body');
const recentScansBody = document.getElementById('recent-scans-body');
const clearRecentBtn = document.getElementById('clear-recent-btn');

// ---- State ----

const tabs = new Map(); // tabId -> tab state
let activeTabId = 'dashboard';
let apiUrl = '';
let saveTimer = null;

// ---- Shared helpers ----

function populateStationSelect(selectEl) {
  selectEl.innerHTML = '';
  for (const { group, stations } of STATION_GROUPS) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const station of stations) {
      const option = document.createElement('option');
      option.value = station.key;
      option.textContent = station.label;
      optgroup.appendChild(option);
    }
    selectEl.appendChild(optgroup);
  }
}

function ensureOptionExists(selectEl, value) {
  if (!value) return;
  const exists = Array.from(selectEl.options).some((o) => o.value === value);
  if (!exists) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    selectEl.appendChild(option);
  }
}

function applyPortsToSelect(selectEl, ports, desired) {
  const value = desired || selectEl.value;
  selectEl.innerHTML = '';

  for (const port of ports) {
    const option = document.createElement('option');
    option.value = port.path;
    option.textContent = port.manufacturer
      ? `${port.path} (${port.manufacturer})`
      : port.path;
    selectEl.appendChild(option);
  }

  if (ports.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No ports found';
    option.disabled = true;
    selectEl.appendChild(option);
  }

  if (value) {
    ensureOptionExists(selectEl, value);
    selectEl.value = value;
  }
}

async function refreshAllPorts() {
  const ports = await window.comBridge.listPorts();
  for (const tab of tabs.values()) {
    applyPortsToSelect(tab.els.portSelect, ports, tab.comPort);
  }
}

function tabLabel(tab) {
  return tab.comPort || 'New Tab';
}

function buildLogRow({ id, timestamp, portLabel, value, station }) {
  const row = document.createElement('tr');
  row.dataset.scanId = id;

  const timeCell = document.createElement('td');
  timeCell.textContent = new Date(timestamp).toLocaleString();

  const portCell = document.createElement('td');
  portCell.textContent = portLabel;

  const valueCell = document.createElement('td');
  valueCell.textContent = value;

  const stationCell = document.createElement('td');
  stationCell.textContent = STATION_LABELS.get(station) || station || '';

  const apiStatusCell = document.createElement('td');
  apiStatusCell.className = 'api-status-cell';
  const apiStatusBadge = document.createElement('span');
  apiStatusBadge.className = 'api-status sending';
  apiStatusBadge.textContent = 'Sending…';
  apiStatusCell.appendChild(apiStatusBadge);

  const apiMessageCell = document.createElement('td');
  apiMessageCell.className = 'api-message-cell';

  row.append(timeCell, portCell, valueCell, stationCell, apiStatusCell, apiMessageCell);
  return row;
}

function updateLogRowApiResult(tbody, { id, status, message }) {
  const row = tbody.querySelector(`tr[data-scan-id="${id}"]`);
  if (!row) return;

  const badge = row.querySelector('.api-status-cell .api-status');
  if (badge) {
    badge.className = `api-status ${status}`;
    badge.textContent = status === 'sent' ? 'Sent' : 'Error';
  }

  const messageCell = row.querySelector('.api-message-cell');
  if (messageCell) {
    messageCell.textContent = message || '';
    messageCell.className = `api-message-cell ${status}`;
  }
}

function trimTableRows(tbody, max) {
  while (tbody.rows.length > max) {
    tbody.deleteRow(tbody.rows.length - 1);
  }
}

function flashSaved(el) {
  el.textContent = 'Saved';
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 1200);
}

function scheduleSaveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistSettings, SAVE_DEBOUNCE_MS);
}

async function persistSettings() {
  const settings = {
    apiUrl,
    tabs: Array.from(tabs.values()).map((tab) => ({
      id: tab.id,
      comPort: tab.comPort,
      baudRate: tab.baudRate,
      stationKey: tab.stationKey
    }))
  };
  await window.comBridge.saveSettings(settings);
}

// ---- Dashboard ----

function renderConnectionsTable() {
  connectionsBody.innerHTML = '';

  if (tabs.size === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty-state';
    cell.textContent = 'No connection tabs yet — click "+" to add one.';
    row.appendChild(cell);
    connectionsBody.appendChild(row);
    return;
  }

  for (const tab of tabs.values()) {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.textContent = tabLabel(tab);

    const portCell = document.createElement('td');
    portCell.textContent = tab.comPort || '—';

    const baudCell = document.createElement('td');
    baudCell.textContent = tab.baudRate;

    const stationCell = document.createElement('td');
    stationCell.textContent = STATION_LABELS.get(tab.stationKey) || tab.stationKey;

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${tab.status}`;
    badge.textContent = tab.status.charAt(0).toUpperCase() + tab.status.slice(1);
    statusCell.appendChild(badge);
    if (tab.statusMessage) {
      const msg = document.createElement('span');
      msg.className = 'connections-status-message';
      msg.textContent = ` ${tab.statusMessage}`;
      statusCell.appendChild(msg);
    }

    row.append(nameCell, portCell, baudCell, stationCell, statusCell);
    connectionsBody.appendChild(row);
  }
}

// ---- Per-tab UI state ----

function setStatus(tab, status, message) {
  tab.status = status;
  tab.statusMessage = message || '';

  tab.els.statusBadge.className = `badge ${status} status-badge`;
  tab.els.statusBadge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  tab.els.statusMessage.textContent = message || '';
  tab.els.tabButton.classList.toggle('tab-connected', status === 'connected');

  if (status === 'error' || status === 'disconnected') {
    setConnectedUiState(tab, false);
  }

  renderConnectionsTable();
}

function setConnectedUiState(tab, isConnected) {
  tab.connected = isConnected;
  tab.els.connectBtn.disabled = isConnected;
  tab.els.disconnectBtn.disabled = !isConnected;
  tab.els.portSelect.disabled = isConnected;
  tab.els.baudSelect.disabled = isConnected;
  tab.els.stationSelect.disabled = isConnected;
  tab.els.refreshBtn.disabled = isConnected;
  renderConnectionsTable();
}

// ---- Tab lifecycle ----

let dashboardTabButton = null;

function setActiveTab(id) {
  activeTabId = id;
  dashboardPanel.classList.toggle('active', id === 'dashboard');
  dashboardTabButton.classList.toggle('active', id === 'dashboard');

  for (const tab of tabs.values()) {
    const isActive = tab.id === id;
    tab.els.panel.classList.toggle('active', isActive);
    tab.els.tabButton.classList.toggle('active', isActive);
  }
}

function buildTabButton(tab) {
  const btn = document.createElement('button');
  btn.className = 'tab-btn';
  btn.dataset.tabId = tab.id;

  const labelSpan = document.createElement('span');
  labelSpan.className = 'tab-btn-label';
  labelSpan.textContent = tabLabel(tab);

  const closeSpan = document.createElement('span');
  closeSpan.className = 'tab-btn-close';
  closeSpan.textContent = '×';
  closeSpan.title = 'Close tab';
  closeSpan.addEventListener('click', (event) => {
    event.stopPropagation();
    closeTab(tab.id);
  });

  btn.append(labelSpan, closeSpan);
  btn.addEventListener('click', () => setActiveTab(tab.id));

  tab.els.tabButton = btn;
  tab.els.tabLabel = labelSpan;
  tabBar.insertBefore(btn, addTabBtn);
}

function buildTabPanel(tab) {
  const fragment = document.importNode(tabTemplate.content, true);
  const panel = fragment.querySelector('.tab-panel');
  panel.dataset.tabId = tab.id;

  const portSelect = panel.querySelector('.port-select');
  const refreshBtn = panel.querySelector('.refresh-btn');
  const baudSelect = panel.querySelector('.baud-select');
  const stationSelect = panel.querySelector('.station-select');
  const connectBtn = panel.querySelector('.connect-btn');
  const disconnectBtn = panel.querySelector('.disconnect-btn');
  const statusBadge = panel.querySelector('.status-badge');
  const statusMessage = panel.querySelector('.status-message');
  const logBody = panel.querySelector('.log-body');
  const clearLogBtn = panel.querySelector('.clear-log-btn');

  populateStationSelect(stationSelect);
  stationSelect.value = tab.stationKey;
  baudSelect.value = String(tab.baudRate);

  refreshBtn.addEventListener('click', () => refreshAllPorts());

  portSelect.addEventListener('change', () => {
    tab.comPort = portSelect.value;
    tab.els.tabLabel.textContent = tabLabel(tab);
    renderConnectionsTable();
    scheduleSaveSettings();
  });

  baudSelect.addEventListener('change', () => {
    tab.baudRate = parseInt(baudSelect.value, 10);
    renderConnectionsTable();
    scheduleSaveSettings();
  });

  stationSelect.addEventListener('change', () => {
    tab.stationKey = stationSelect.value;
    renderConnectionsTable();
    scheduleSaveSettings();
  });

  connectBtn.addEventListener('click', () => connectTab(tab.id));
  disconnectBtn.addEventListener('click', () => disconnectTab(tab.id));
  clearLogBtn.addEventListener('click', () => {
    logBody.innerHTML = '';
  });

  tab.els.panel = panel;
  tab.els.portSelect = portSelect;
  tab.els.refreshBtn = refreshBtn;
  tab.els.baudSelect = baudSelect;
  tab.els.stationSelect = stationSelect;
  tab.els.connectBtn = connectBtn;
  tab.els.disconnectBtn = disconnectBtn;
  tab.els.statusBadge = statusBadge;
  tab.els.statusMessage = statusMessage;
  tab.els.logBody = logBody;
  tab.els.clearLogBtn = clearLogBtn;

  tabPanelsContainer.appendChild(panel);
}

function createTabState(config) {
  const tab = {
    id: config.id || crypto.randomUUID(),
    comPort: config.comPort || '',
    baudRate: config.baudRate || 19200,
    stationKey: config.stationKey || STATIONS[0].key,
    connected: false,
    status: 'disconnected',
    statusMessage: '',
    els: {}
  };

  buildTabButton(tab);
  buildTabPanel(tab);
  tabs.set(tab.id, tab);
  return tab;
}

function addTab() {
  const tab = createTabState({});
  setActiveTab(tab.id);
  renderConnectionsTable();
  scheduleSaveSettings();
  refreshAllPorts();
  return tab;
}

async function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  if (tab.connected) {
    const confirmed = window.confirm(`${tabLabel(tab)} is still connected. Disconnect and close this tab?`);
    if (!confirmed) return;
    await disconnectTab(id);
  }

  tab.els.tabButton.remove();
  tab.els.panel.remove();
  tabs.delete(id);

  if (activeTabId === id) {
    const remaining = Array.from(tabs.keys());
    setActiveTab(remaining.length > 0 ? remaining[remaining.length - 1] : 'dashboard');
  }

  renderConnectionsTable();
  scheduleSaveSettings();
}

async function connectTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  const path = tab.els.portSelect.value;
  const baudRate = parseInt(tab.els.baudSelect.value, 10);
  const stationKey = tab.els.stationSelect.value;

  if (!path) {
    setStatus(tab, 'error', 'No COM port selected');
    return;
  }

  tab.comPort = path;
  tab.baudRate = baudRate;
  tab.stationKey = stationKey;
  tab.els.tabLabel.textContent = tabLabel(tab);

  tab.els.connectBtn.disabled = true;
  const result = await window.comBridge.connect({ tabId: id, path, baudRate, stationKey, apiUrl });

  if (!result.ok) {
    setStatus(tab, 'error', result.error);
    tab.els.connectBtn.disabled = false;
    return;
  }

  setConnectedUiState(tab, true);
  scheduleSaveSettings();
}

async function disconnectTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  tab.els.disconnectBtn.disabled = true;
  await window.comBridge.disconnect(id);
  setConnectedUiState(tab, false);
}

// ---- Dashboard tab button (pinned, not closable) ----

dashboardTabButton = document.createElement('button');
dashboardTabButton.className = 'tab-btn dashboard-tab';
dashboardTabButton.textContent = 'Dashboard';
dashboardTabButton.addEventListener('click', () => setActiveTab('dashboard'));
tabBar.insertBefore(dashboardTabButton, addTabBtn);
setActiveTab('dashboard');

// ---- Static event listeners ----

addTabBtn.addEventListener('click', () => addTab());

apiUrlInput.addEventListener('change', () => {
  apiUrl = apiUrlInput.value.trim();
  flashSaved(apiUrlSavedFlash);
  scheduleSaveSettings();
});

clearRecentBtn.addEventListener('click', () => {
  recentScansBody.innerHTML = '';
});

// ---- IPC subscriptions (routed by tabId, also feed the dashboard) ----

window.comBridge.onStatus(({ tabId, status, message }) => {
  const tab = tabs.get(tabId);
  if (!tab) return;
  setStatus(tab, status, message);
});

window.comBridge.onScan((scan) => {
  const tab = tabs.get(scan.tabId);
  if (!tab) return;

  const logRow = buildLogRow({
    id: scan.id,
    timestamp: scan.timestamp,
    portLabel: scan.port,
    value: scan.value,
    station: scan.station
  });
  tab.els.logBody.insertBefore(logRow, tab.els.logBody.firstChild);

  const dashRow = buildLogRow({
    id: scan.id,
    timestamp: scan.timestamp,
    portLabel: `${tabLabel(tab)} (${scan.port})`,
    value: scan.value,
    station: scan.station
  });
  recentScansBody.insertBefore(dashRow, recentScansBody.firstChild);
  trimTableRows(recentScansBody, RECENT_SCANS_LIMIT);
});

window.comBridge.onApiResult((result) => {
  const tab = tabs.get(result.tabId);
  if (tab) {
    updateLogRowApiResult(tab.els.logBody, result);
  }
  updateLogRowApiResult(recentScansBody, result);
});

// ---- Init ----

async function init() {
  const settings = await window.comBridge.loadSettings();
  apiUrl = settings.apiUrl || '';
  apiUrlInput.value = apiUrl;

  const savedTabs = settings.tabs && settings.tabs.length > 0
    ? settings.tabs
    : [{ comPort: '', baudRate: 19200, stationKey: STATIONS[0].key }];

  for (const tabConfig of savedTabs) {
    createTabState(tabConfig);
  }

  setActiveTab('dashboard');
  renderConnectionsTable();
  await refreshAllPorts();
}

init();

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

// This bridge's own STATION_GROUPS `.key` values (e.g. 'joint_prehung') are
// internal bookkeeping used for the real COM-connection Station dropdown
// and settings persistence — they are NOT necessarily the literal
// `station_key` value the website's STATIONS sheet/API actually expects.
// Confirmed live (GET /api/stations against the running system) that for
// the Pre-Hung joint station specifically, the sheet's real columns are
// station_key="Pre-Hung" / station_name="joint_prehung" — the reverse of
// what this bridge's internal key/label pairing would suggest. Manual Scan
// talks to the website directly, so it must send the real station_key, not
// this bridge's internal key — this override table is exactly (and only)
// that translation. It intentionally does NOT touch the real
// COM-connection path (stationSelect/conn.stationKey), which still sends
// 'joint_prehung' today; only Pre-Hung is listed here because only Pre-Hung
// has been live-confirmed to differ — no other station is assumed to.
const MANUAL_SCAN_API_STATION_KEY_OVERRIDES = new Map([
  ['joint_prehung', 'Pre-Hung']
]);

// Resolves whatever text an operator typed/picked into the Manual Scan
// station field to the API's real station_key: an exact match against this
// bridge's internal STATIONS `.key` wins, then a case-insensitive match
// against `.label` (so typing "pre-hung" or picking "Pre-Hung" from the
// datalist both resolve the same way), and otherwise the raw text is
// passed through as-is — manual testing is allowed to exercise station
// keys this bridge doesn't know about. Whatever internal key is found is
// then run through MANUAL_SCAN_API_STATION_KEY_OVERRIDES so the value that
// actually gets sent is the website's real station_key (e.g. "Pre-Hung"),
// not this bridge's internal identifier.
function resolveManualStationKey(rawText) {
  const text = (rawText || '').trim();
  if (!text) return '';

  const byKey = STATIONS.find((s) => s.key === text);
  if (byKey) return MANUAL_SCAN_API_STATION_KEY_OVERRIDES.get(byKey.key) || byKey.key;

  const lower = text.toLowerCase();
  const byLabel = STATIONS.find((s) => s.label.toLowerCase() === lower);
  if (byLabel) return MANUAL_SCAN_API_STATION_KEY_OVERRIDES.get(byLabel.key) || byLabel.key;

  return text;
}

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
const deliveryPhotosPanel = document.getElementById('panel-delivery-photos');
const connectionsBody = document.getElementById('connections-body');
const recentScansBody = document.getElementById('recent-scans-body');
const clearRecentBtn = document.getElementById('clear-recent-btn');
const printJobsBody = document.getElementById('print-jobs-body');
const clearPrintJobsBtn = document.getElementById('clear-print-jobs-btn');

const printerSelect = document.getElementById('printer-select');
const printerRefreshBtn = document.getElementById('printer-refresh-btn');
const printerSaveBtn = document.getElementById('printer-save-btn');
const printerCheckBtn = document.getElementById('printer-check-btn');
const printerSavedFlash = document.getElementById('printer-saved');
const printerStatusBadge = document.getElementById('printer-status-badge');
const printerStatusMessage = document.getElementById('printer-status-message');
const testWidthMmInput = document.getElementById('test-width-mm');
const testHeightMmInput = document.getElementById('test-height-mm');
const printTestPatternBtn = document.getElementById('print-test-pattern-btn');
const reprintJobIdInput = document.getElementById('reprint-job-id-input');
const reprintTestBtn = document.getElementById('reprint-test-btn');
const printerTestResult = document.getElementById('printer-test-result');
const manualScanStationList = document.getElementById('manual-scan-station-list');

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

// One shared datalist backs every tab's Manual Scan station field (a
// per-tab-panel-template element would mean duplicate ids once cloned
// across tabs), listing known station labels as suggestions while still
// allowing free text — see resolveManualStationKey.
function populateManualScanStationList() {
  manualScanStationList.innerHTML = '';
  for (const station of STATIONS) {
    const option = document.createElement('option');
    option.value = station.label;
    manualScanStationList.appendChild(option);
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

// One row per job_id, updated in place as it moves through
// QUEUED -> CLAIMED -> PRINTING -> PRINTED/FAILED (or SKIPPED, if this
// bridge instance had already seen the job_id) — mirrors how scan rows
// already update in place via updateLogRowApiResult, just keyed by job_id
// instead of scan id.
function upsertPrintJobRow({ jobId, status, message }) {
  let row = printJobsBody.querySelector(`tr[data-job-id="${CSS.escape(jobId)}"]`);

  if (!row) {
    row = document.createElement('tr');
    row.dataset.jobId = jobId;

    const timeCell = document.createElement('td');
    const jobCell = document.createElement('td');
    jobCell.className = 'job-id-cell';
    jobCell.textContent = jobId;
    const statusCell = document.createElement('td');
    statusCell.className = 'print-status-cell';
    const badge = document.createElement('span');
    badge.className = 'api-status';
    statusCell.appendChild(badge);
    const messageCell = document.createElement('td');
    messageCell.className = 'api-message-cell';

    row.append(timeCell, jobCell, statusCell, messageCell);
    printJobsBody.insertBefore(row, printJobsBody.firstChild);
    trimTableRows(printJobsBody, RECENT_SCANS_LIMIT);
  }

  row.cells[0].textContent = new Date().toLocaleTimeString();
  const badge = row.querySelector('.api-status');
  badge.className = `api-status ${status.toLowerCase()}`;
  badge.textContent = status;
  row.cells[3].textContent = message || '';
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

// Pinned tabs - always present, never closable - keyed by the id passed to
// setActiveTab(). Populated once each button/panel pair is built, below.
const pinnedTabs = new Map(); // id -> { panel, button }

function setActiveTab(id) {
  activeTabId = id;
  for (const [pinnedId, { panel, button }] of pinnedTabs) {
    panel.classList.toggle('active', pinnedId === id);
    button.classList.toggle('active', pinnedId === id);
  }

  for (const tab of tabs.values()) {
    const isActive = tab.id === id;
    tab.els.panel.classList.toggle('active', isActive);
    tab.els.tabButton.classList.toggle('active', isActive);
  }
}

function buildPinnedTabButton(id, label) {
  const btn = document.createElement('button');
  btn.className = 'tab-btn dashboard-tab';
  btn.textContent = label;
  btn.addEventListener('click', () => setActiveTab(id));
  tabBar.insertBefore(btn, addTabBtn);
  return btn;
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
  const manualScanStationInput = panel.querySelector('.manual-scan-station-input');
  const manualScanInput = panel.querySelector('.manual-scan-input');
  const manualScanBtn = panel.querySelector('.manual-scan-btn');
  const manualScanResult = panel.querySelector('.manual-scan-result');

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

  // Defaults to this tab's current connection station as a convenience
  // starting point, but is otherwise fully independent from here on — it
  // does not read from or write back to stationSelect, so testing a
  // different station never touches the tab's real connection settings.
  manualScanStationInput.value = STATION_LABELS.get(tab.stationKey) || tab.stationKey || '';

  manualScanBtn.addEventListener('click', () => submitManualScan(tab));
  manualScanInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitManualScan(tab);
    }
  });
  manualScanStationInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitManualScan(tab);
    }
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
  tab.els.manualScanStationInput = manualScanStationInput;
  tab.els.manualScanInput = manualScanInput;
  tab.els.manualScanBtn = manualScanBtn;
  tab.els.manualScanResult = manualScanResult;

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
    manualScanBusy: false,
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

// ---- Manual scan (testing) ----
// Simulates a scanner input for a station picked/typed right here in the
// Manual Scan section — deliberately independent of the tab's own
// connect-time Station select (tab.els.stationSelect), so testing e.g.
// Pre-Hung doesn't require this tab to be connected, or even configured,
// for that station. Needs no physical scanner and no open COM connection
// at all. This only handles local input validation (trim/empty) and a
// busy-guard against double submission — the actual submission goes
// through the exact same postScanToApi()/printProcessor path a real
// COM-port scan uses (see main.js's manual-scan IPC handler), so a manual
// "5432-D" against "Pre-Hung" behaves identically to physically scanning
// it: same request to /api/com-scans, same scan-received/scan-api-result
// events feeding this tab's Scan Log and the dashboard's Recently Scanned
// table, and any returned printJob is enqueued into the same
// PrintJobProcessor a real scan would use.
async function submitManualScan(tab) {
  if (tab.manualScanBusy) return;

  const input = tab.els.manualScanInput;
  const code = input.value.trim();
  if (!code) {
    tab.els.manualScanResult.textContent = 'Enter a code to submit.';
    return;
  }

  const stationText = tab.els.manualScanStationInput.value.trim();
  if (!stationText) {
    tab.els.manualScanResult.textContent = 'Enter or choose a station to submit.';
    return;
  }
  const stationKey = resolveManualStationKey(stationText);

  tab.manualScanBusy = true;
  tab.els.manualScanBtn.disabled = true;
  tab.els.manualScanResult.textContent = 'Sending…';

  try {
    const result = await window.comBridge.manualScan({
      tabId: tab.id,
      code,
      stationKey,
      apiUrl
    });

    if (result.ok) {
      input.value = '';
      // The actual send outcome (Sent/Error) appears in the Scan Log row
      // below via the normal scan-received/scan-api-result events, so no
      // need to duplicate it here.
      tab.els.manualScanResult.textContent = '';
    } else {
      tab.els.manualScanResult.textContent = result.error || 'Failed to submit manual scan.';
    }
  } finally {
    tab.manualScanBusy = false;
    tab.els.manualScanBtn.disabled = false;
  }
}

// ---- Printer panel ----
// A diagnostic/setup panel, not a label editor — select which installed
// Windows printer is the Zebra GK420D, confirm the bridge can see it, and
// run two kinds of test print: a bridge-generated calibration pattern (for
// checking physical size/feed) and a reprint of a real, already-rendered
// delivery label (for checking the whole real pipeline) — see
// printer-service.js and print-job-client.js's reprintJob.

function setPrinterStatusBadge(status, message) {
  printerStatusBadge.className = `badge ${status}`;
  printerStatusBadge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  printerStatusMessage.textContent = message || '';
}

async function refreshPrinterList() {
  const desired = printerSelect.value;
  const result = await window.comBridge.listPrinters();

  printerSelect.innerHTML = '';

  if (!result.supported) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Not available on this platform (Windows only)';
    option.disabled = true;
    printerSelect.appendChild(option);
    return;
  }

  if (result.printers.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No printers found';
    option.disabled = true;
    printerSelect.appendChild(option);
    return;
  }

  for (const printer of result.printers) {
    const option = document.createElement('option');
    option.value = printer.name;
    option.textContent = printer.isOffline ? `${printer.name} (offline)` : printer.name;
    printerSelect.appendChild(option);
  }

  const configuredName = await window.comBridge.getPrinterName();
  const toSelect = desired || configuredName;
  if (toSelect) {
    ensureOptionExists(printerSelect, toSelect);
    printerSelect.value = toSelect;
  }
}

async function checkConfiguredPrinterStatus() {
  const configuredName = await window.comBridge.getPrinterName();
  if (!configuredName) {
    setPrinterStatusBadge('disconnected', 'Not configured');
    return;
  }

  const status = await window.comBridge.getPrinterStatus(configuredName);
  if (!status.supported) {
    setPrinterStatusBadge('error', `${configuredName} — not checkable on this platform (Windows only)`);
    return;
  }
  if (!status.found) {
    setPrinterStatusBadge('error', `${configuredName} — not found`);
    return;
  }
  if (status.offline) {
    setPrinterStatusBadge('error', `${configuredName} — offline`);
    return;
  }
  setPrinterStatusBadge('connected', configuredName);
}

printerRefreshBtn.addEventListener('click', () => refreshPrinterList());

printerSaveBtn.addEventListener('click', async () => {
  await window.comBridge.savePrinterName(printerSelect.value);
  flashSaved(printerSavedFlash);
  await checkConfiguredPrinterStatus();
});

printerCheckBtn.addEventListener('click', () => checkConfiguredPrinterStatus());

printTestPatternBtn.addEventListener('click', async () => {
  printerTestResult.textContent = 'Printing test pattern…';
  const widthMm = Number(testWidthMmInput.value);
  const heightMm = Number(testHeightMmInput.value);
  const result = await window.comBridge.printTestPattern({ widthMm, heightMm });
  printerTestResult.textContent = result.ok
    ? `Test pattern (${widthMm}x${heightMm}mm) submitted.`
    : `Failed: ${result.error}`;
});

reprintTestBtn.addEventListener('click', async () => {
  const jobId = reprintJobIdInput.value.trim();
  if (!jobId) {
    printerTestResult.textContent = 'Enter a job id to reprint.';
    return;
  }
  printerTestResult.textContent = `Requesting reprint of ${jobId}…`;
  const result = await window.comBridge.reprintTestJob(jobId);
  printerTestResult.textContent = result.ok
    ? `Reprint of ${jobId} queued — see Print Jobs below.`
    : `Failed: ${result.error}`;
});

// ---- Pinned tab buttons (Dashboard, Delivery Photos - always present, not closable) ----

pinnedTabs.set('dashboard', { panel: dashboardPanel, button: buildPinnedTabButton('dashboard', 'Dashboard') });
pinnedTabs.set('delivery-photos', { panel: deliveryPhotosPanel, button: buildPinnedTabButton('delivery-photos', 'Delivery Photos') });
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

clearPrintJobsBtn.addEventListener('click', () => {
  printJobsBody.innerHTML = '';
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

window.comBridge.onPrintJobEvent((event) => {
  upsertPrintJobRow(event);
});

// ---- Init ----

async function init() {
  populateManualScanStationList();

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

  await refreshPrinterList();
  await checkConfiguredPrinterStatus();
}

init();

// ---- Delivery Photos panel ----
// A separate section (window.deliveryPhotos, from preload.js) talking to a
// separate, isolated worker process - see main.js's "Delivery Photos" block.
// Nothing here touches window.comBridge or any of the scanner/printer state
// above.

const dp = {
  serviceBadge: document.getElementById('dp-service-badge'),
  ipadBadge: document.getElementById('dp-ipad-badge'),
  storageBadge: document.getElementById('dp-storage-badge'),
  address: document.getElementById('dp-address'),
  copyAddressBtn: document.getElementById('dp-copy-address-btn'),
  photoRoot: document.getElementById('dp-photo-root'),
  filedToday: document.getElementById('dp-filed-today'),
  failedToday: document.getElementById('dp-failed-today'),
  lastError: document.getElementById('dp-last-error'),
  startBtn: document.getElementById('dp-start-btn'),
  stopBtn: document.getElementById('dp-stop-btn'),
  testStorageBtn: document.getElementById('dp-test-storage-btn'),
  openFolderBtn: document.getElementById('dp-open-folder-btn'),
  openLogsBtn: document.getElementById('dp-open-logs-btn'),
  testResult: document.getElementById('dp-test-result'),
  hostnameInput: document.getElementById('dp-hostname-input'),
  portInput: document.getElementById('dp-port-input'),
  rootInput: document.getElementById('dp-root-input'),
  autoStartInput: document.getElementById('dp-autostart-input'),
  saveBtn: document.getElementById('dp-save-btn'),
  savedFlash: document.getElementById('dp-saved-flash'),
  saveError: document.getElementById('dp-save-error')
};

function setBadge(el, status, text) {
  el.className = `badge ${status}`;
  el.textContent = text;
}

// Renders whatever the worker process most recently reported - see
// worker-entry.js's Runtime.report(), relayed here via main.js's
// 'delivery-photos-status' event. `status` is null before anything has
// been heard yet (e.g. the service has never been started this session).
function renderDeliveryPhotosStatus(status) {
  if (!status || status.state === 'not_configured') {
    setBadge(dp.serviceBadge, 'disconnected', 'Not set up');
    setBadge(dp.ipadBadge, 'disconnected', 'Unavailable');
    setBadge(dp.storageBadge, 'disconnected', 'Unknown');
    dp.address.textContent = '-';
    dp.copyAddressBtn.disabled = true;
    dp.photoRoot.textContent = '-';
    dp.lastError.textContent = (status && status.lastError) || '-';
    return;
  }

  const running = status.state === 'running';
  setBadge(dp.serviceBadge, running ? 'connected' : status.state === 'restarting' ? 'error' : 'disconnected', running ? 'Running' : status.state === 'stopped' ? 'Stopped' : status.state === 'restarting' ? 'Restarting…' : 'Error');
  setBadge(dp.ipadBadge, running ? 'connected' : 'disconnected', running ? 'Available' : 'Unavailable');
  setBadge(dp.storageBadge, running ? 'connected' : 'disconnected', running ? 'Connected' : 'Unknown');

  dp.address.textContent = running && status.hostname ? `https://${status.hostname}:${status.port}/` : '-';
  dp.copyAddressBtn.disabled = !(running && status.hostname);
  dp.photoRoot.textContent = status.photoRoot || '-';
  dp.filedToday.textContent = status.filedToday || 0;
  dp.failedToday.textContent = status.failedToday || 0;
  dp.lastError.textContent = status.lastError || '-';
}

dp.startBtn.addEventListener('click', async () => {
  dp.startBtn.disabled = true;
  try {
    await window.deliveryPhotos.start();
  } finally {
    dp.startBtn.disabled = false;
  }
});

dp.stopBtn.addEventListener('click', async () => {
  dp.stopBtn.disabled = true;
  try {
    await window.deliveryPhotos.stop();
  } finally {
    dp.stopBtn.disabled = false;
  }
});

dp.copyAddressBtn.addEventListener('click', () => {
  if (dp.address.textContent && dp.address.textContent !== '-') navigator.clipboard.writeText(dp.address.textContent);
});

dp.testStorageBtn.addEventListener('click', async () => {
  dp.testStorageBtn.disabled = true;
  dp.testResult.hidden = false;
  dp.testResult.textContent = 'Testing… this can take a little while if the network drive is slow to respond.';
  try {
    const result = await window.deliveryPhotos.testStorage();
    if (result.ok) {
      dp.testResult.textContent = result.steps.map((s) => `${s.ok ? '[PASS]' : '[FAIL]'} ${s.label}${s.detail ? ' - ' + s.detail : ''}`).join('\n');
    } else {
      dp.testResult.textContent = `[FAIL] ${result.error}`;
    }
  } finally {
    dp.testStorageBtn.disabled = false;
  }
});

dp.openFolderBtn.addEventListener('click', async () => {
  const result = await window.deliveryPhotos.openPhotographsFolder();
  if (!result.ok) alert(result.error);
});

dp.openLogsBtn.addEventListener('click', async () => {
  const result = await window.deliveryPhotos.openLogsFolder();
  if (!result.ok) alert(result.error);
});

dp.saveBtn.addEventListener('click', async () => {
  dp.saveError.hidden = true;
  dp.saveBtn.disabled = true;
  try {
    const result = await window.deliveryPhotos.saveConfig({
      hostname: dp.hostnameInput.value.trim(),
      port: dp.portInput.value ? Number(dp.portInput.value) : undefined,
      photoRoot: dp.rootInput.value.trim(),
      autoStart: dp.autoStartInput.checked
    });
    if (result.ok) {
      flashSaved(dp.savedFlash);
      dp.hostnameInput.value = result.config.hostname;
      dp.portInput.value = result.config.port;
      dp.rootInput.value = result.config.photoRoot;
    } else {
      dp.saveError.hidden = false;
      dp.saveError.textContent = result.errors.join(' ');
    }
  } finally {
    dp.saveBtn.disabled = false;
  }
});

window.deliveryPhotos.onStatus((status) => renderDeliveryPhotosStatus(status));

async function initDeliveryPhotos() {
  const result = await window.deliveryPhotos.getConfig();
  if (result.ok) {
    dp.hostnameInput.value = result.config.hostname;
    dp.portInput.value = result.config.port;
    dp.rootInput.value = result.config.photoRoot;
    dp.autoStartInput.checked = result.config.autoStart;
  }
  renderDeliveryPhotosStatus(await window.deliveryPhotos.getStatus());
}

initDeliveryPhotos();

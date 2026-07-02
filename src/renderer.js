const STATIONS = [
  { key: 'door_cutting', label: 'Door Cutting' },
  { key: 'lipping_edging', label: 'Door Lipping' },
  { key: 'door_press', label: 'Door Press' },
  { key: 'door_machining', label: 'Door CNC' },
  { key: 'spray_finishing', label: 'Door Spray' },
  { key: 'door_bench', label: 'Door Bench' },
  { key: 'assembly_qc', label: 'Door Assembly' },
  { key: 'door_packed_ready', label: 'Door Pre-Hung' },
  { key: 'frame_cutting', label: 'Frame Cut & Mould' },
  { key: 'frame_cut_to_size', label: 'Frame Cut To Size' },
  { key: 'frame_machining', label: 'Frame CNC' },
  { key: 'frame_sanding', label: 'Frame Sand' },
  { key: 'frame_finish', label: 'Frame Spray' },
  { key: 'frame_assembly_flat_pack', label: 'Frame Assembly' },
  { key: 'frame_packed_ready', label: 'Frame Pre-Hung' }
];

const STATION_LABELS = new Map(STATIONS.map((s) => [s.key, s.label]));

const portSelect = document.getElementById('port-select');
const baudSelect = document.getElementById('baud-select');
const stationSelect = document.getElementById('station-select');
const apiUrlInput = document.getElementById('api-url-input');
const refreshBtn = document.getElementById('refresh-btn');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const statusBadge = document.getElementById('status-badge');
const statusMessage = document.getElementById('status-message');
const logBody = document.getElementById('log-body');
const clearLogBtn = document.getElementById('clear-log-btn');

function populateStationSelect() {
  stationSelect.innerHTML = '';
  for (const station of STATIONS) {
    const option = document.createElement('option');
    option.value = station.key;
    option.textContent = station.label;
    stationSelect.appendChild(option);
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

async function refreshPorts(preferredValue) {
  const desired = preferredValue || portSelect.value;
  const ports = await window.comBridge.listPorts();
  portSelect.innerHTML = '';

  for (const port of ports) {
    const option = document.createElement('option');
    option.value = port.path;
    option.textContent = port.manufacturer
      ? `${port.path} (${port.manufacturer})`
      : port.path;
    portSelect.appendChild(option);
  }

  if (ports.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No ports found';
    option.disabled = true;
    portSelect.appendChild(option);
  }

  if (desired) {
    ensureOptionExists(portSelect, desired);
    portSelect.value = desired;
  }
}

function setStatus(status, message) {
  statusBadge.className = `badge ${status}`;
  statusBadge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  statusMessage.textContent = message || '';
}

function setConnectedUiState(isConnected) {
  connectBtn.disabled = isConnected;
  disconnectBtn.disabled = !isConnected;
  portSelect.disabled = isConnected;
  baudSelect.disabled = isConnected;
  stationSelect.disabled = isConnected;
  apiUrlInput.disabled = isConnected;
  refreshBtn.disabled = isConnected;
}

function addLogRow({ id, timestamp, port, value, station }) {
  const row = document.createElement('tr');
  row.dataset.scanId = id;

  const timeCell = document.createElement('td');
  timeCell.textContent = new Date(timestamp).toLocaleString();

  const portCell = document.createElement('td');
  portCell.textContent = port;

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

  row.appendChild(timeCell);
  row.appendChild(portCell);
  row.appendChild(valueCell);
  row.appendChild(stationCell);
  row.appendChild(apiStatusCell);
  row.appendChild(apiMessageCell);

  logBody.insertBefore(row, logBody.firstChild);
}

function updateLogRowApiResult({ id, status, message }) {
  const row = logBody.querySelector(`tr[data-scan-id="${id}"]`);
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

refreshBtn.addEventListener('click', () => refreshPorts());

connectBtn.addEventListener('click', async () => {
  const path = portSelect.value;
  const baudRate = parseInt(baudSelect.value, 10);
  const stationKey = stationSelect.value;
  const apiUrl = apiUrlInput.value.trim();

  if (!path) {
    setStatus('error', 'No COM port selected');
    return;
  }

  connectBtn.disabled = true;
  const result = await window.comBridge.connect({ path, baudRate, stationKey, apiUrl });

  if (!result.ok) {
    setStatus('error', result.error);
    connectBtn.disabled = false;
    return;
  }

  setConnectedUiState(true);
});

disconnectBtn.addEventListener('click', async () => {
  disconnectBtn.disabled = true;
  await window.comBridge.disconnect();
  setConnectedUiState(false);
});

clearLogBtn.addEventListener('click', () => {
  logBody.innerHTML = '';
});

saveSettingsBtn.addEventListener('click', async () => {
  const settings = {
    comPort: portSelect.value,
    baudRate: parseInt(baudSelect.value, 10),
    stationKey: stationSelect.value,
    apiUrl: apiUrlInput.value.trim()
  };

  await window.comBridge.saveSettings(settings);

  const original = saveSettingsBtn.textContent;
  saveSettingsBtn.textContent = 'Saved';
  saveSettingsBtn.disabled = true;
  setTimeout(() => {
    saveSettingsBtn.textContent = original;
    saveSettingsBtn.disabled = false;
  }, 1200);
});

window.comBridge.onStatus(({ status, message }) => {
  setStatus(status, message);

  if (status === 'error' || status === 'disconnected') {
    setConnectedUiState(false);
  }
});

window.comBridge.onScan((scan) => {
  addLogRow(scan);
});

window.comBridge.onApiResult((result) => {
  updateLogRowApiResult(result);
});

async function init() {
  populateStationSelect();

  const settings = await window.comBridge.loadSettings();

  await refreshPorts(settings.comPort);
  baudSelect.value = String(settings.baudRate);
  stationSelect.value = settings.stationKey;
  apiUrlInput.value = settings.apiUrl || '';
}

init();

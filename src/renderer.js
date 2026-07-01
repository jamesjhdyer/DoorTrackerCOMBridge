const portSelect = document.getElementById('port-select');
const baudSelect = document.getElementById('baud-select');
const refreshBtn = document.getElementById('refresh-btn');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const statusBadge = document.getElementById('status-badge');
const statusMessage = document.getElementById('status-message');
const logBody = document.getElementById('log-body');
const clearLogBtn = document.getElementById('clear-log-btn');

async function refreshPorts() {
  const ports = await window.comBridge.listPorts();
  portSelect.innerHTML = '';

  if (ports.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'No ports found';
    option.disabled = true;
    portSelect.appendChild(option);
    return;
  }

  for (const port of ports) {
    const option = document.createElement('option');
    option.value = port.path;
    option.textContent = port.manufacturer
      ? `${port.path} (${port.manufacturer})`
      : port.path;
    portSelect.appendChild(option);
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
  refreshBtn.disabled = isConnected;
}

function addLogRow({ timestamp, port, value }) {
  const row = document.createElement('tr');

  const timeCell = document.createElement('td');
  timeCell.textContent = new Date(timestamp).toLocaleString();

  const portCell = document.createElement('td');
  portCell.textContent = port;

  const valueCell = document.createElement('td');
  valueCell.textContent = value;

  row.appendChild(timeCell);
  row.appendChild(portCell);
  row.appendChild(valueCell);

  logBody.insertBefore(row, logBody.firstChild);
}

refreshBtn.addEventListener('click', refreshPorts);

connectBtn.addEventListener('click', async () => {
  const path = portSelect.value;
  const baudRate = parseInt(baudSelect.value, 10);

  if (!path) {
    setStatus('error', 'No COM port selected');
    return;
  }

  connectBtn.disabled = true;
  const result = await window.comBridge.connect(path, baudRate);

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

window.comBridge.onStatus(({ status, message }) => {
  setStatus(status, message);

  if (status === 'error' || status === 'disconnected') {
    setConnectedUiState(false);
  }
});

window.comBridge.onScan((scan) => {
  addLogRow(scan);
});

refreshPorts();

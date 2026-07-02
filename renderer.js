document.addEventListener('DOMContentLoaded', () => {
  const portSelect = document.getElementById('portSelect');
  const baudInput = document.getElementById('baudRate');
  const connectButton = document.getElementById('connectButton');
  const disconnectButton = document.getElementById('disconnectButton');
  const statusValue = document.getElementById('statusValue');
  const statusMessage = document.getElementById('statusMessage');
  const logList = document.getElementById('logList');

  const refreshPorts = async () => {
    try {
      const ports = await window.electronAPI.getPorts();
      const currentValue = portSelect.value;
      portSelect.innerHTML = '';

      if (ports.length === 0) {
        const fallbackOption = document.createElement('option');
        fallbackOption.textContent = 'No COM ports found';
        fallbackOption.value = '';
        portSelect.appendChild(fallbackOption);
      } else {
        ports.forEach((port) => {
          const option = document.createElement('option');
          option.value = port.path;
          option.textContent = `${port.path} (${port.manufacturer})`;
          portSelect.appendChild(option);
        });
      }

      if (currentValue) {
        portSelect.value = currentValue;
      }
    } catch (error) {
      console.error(error);
      statusValue.textContent = 'Error';
      statusMessage.textContent = 'Unable to list COM ports.';
    }
  };

  const updateControls = (status) => {
    const connected = status === 'Connected';
    connectButton.disabled = connected || !portSelect.value || !baudInput.value;
    disconnectButton.disabled = !connected;
    portSelect.disabled = connected;
    baudInput.disabled = connected;
  };

  const updateStatus = (payload) => {
    statusValue.textContent = payload.status || 'Disconnected';
    statusValue.className = `status-badge ${payload.status ? payload.status.toLowerCase() : 'disconnected'}`;
    statusMessage.textContent = payload.message || 'Ready to connect.';
    updateControls(payload.status);
  };

  const appendLogEntry = (entry) => {
    const item = document.createElement('li');
    item.className = 'log-entry';
    item.innerHTML = `
      <span class="entry-time">${escapeHtml(entry.timestamp)}</span>
      <span class="entry-port">${escapeHtml(entry.port)}</span>
      <span class="entry-value">${escapeHtml(entry.value)}</span>
    `;
    logList.prepend(item);
  };

  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  connectButton.addEventListener('click', async () => {
    const selectedPort = portSelect.value;
    const baudRate = baudInput.value;

    if (!selectedPort) {
      statusValue.textContent = 'Error';
      statusMessage.textContent = 'Select a COM port first.';
      return;
    }

    const result = await window.electronAPI.connectPort({ portPath: selectedPort, baudRate });
    if (!result.ok) {
      statusValue.textContent = 'Error';
      statusMessage.textContent = `Connection failed: ${result.error}`;
      updateControls('Error');
    }
  });

  disconnectButton.addEventListener('click', async () => {
    const result = await window.electronAPI.disconnectPort();
    if (!result.ok) {
      statusValue.textContent = 'Error';
      statusMessage.textContent = `Disconnect failed: ${result.error}`;
    }
  });

  window.electronAPI.onScan(appendLogEntry);
  window.electronAPI.onStatus(updateStatus);

  (async () => {
    await refreshPorts();
    const initialStatus = await window.electronAPI.getStatus();
    updateStatus(initialStatus);
  })();
});

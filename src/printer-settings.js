// Persists the selected Windows printer queue name. A separate small JSON
// file (rather than folding into settings.json's existing apiUrl/tabs
// shape) — same "a JSON file under userData" pattern already used for the
// main settings, kept isolated so this new, independent concern can't
// interact with or risk the existing, working apiUrl/tabs persistence.
//
// There is deliberately no fallback to "just use the Windows default
// printer" anywhere here — an empty/missing printerName means "not
// configured", full stop; see printer-service.js, which treats that as a
// hard error rather than silently guessing a printer.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function filePath() {
  return path.join(app.getPath('userData'), 'printer-settings.json');
}

function getPrinterName() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.printerName === 'string' ? parsed.printerName : '';
  } catch {
    return '';
  }
}

function setPrinterName(printerName) {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ printerName: printerName || '' }, null, 2), 'utf8');
}

module.exports = { getPrinterName, setPrinterName };

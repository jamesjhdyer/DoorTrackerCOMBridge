// The COM connection options a tab can be set to - stations, baud rates - and
// the one check of whether a connection's settings are acceptable.
//
// This file works unchanged in both the Windows app's own page (loaded as a
// plain <script> before renderer.js) and the main process / Remote Admin
// (loaded with require()) - see the export lines at the top. Keeping it as
// ONE file is deliberate: the local tabs and Remote Admin must always agree
// on exactly which stations and baud rates exist, with no second copy to
// drift apart.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ComOptions = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
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

  const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
  const DEFAULT_BAUD_RATE = 19200;

  // A port name exactly as SerialPort.list() reports one: COM1..COM256 on
  // Windows, a /dev/tty.* or /dev/cu.* device on macOS (development only).
  // Never anything that could be read as some other kind of path.
  const PORT_PATTERNS = {
    win32: /^COM[1-9][0-9]{0,2}$/,
    other: /^\/dev\/(tty|cu)[A-Za-z0-9._-]{1,60}$/
  };

  function isStationKey(key) {
    return STATIONS.some((s) => s.key === key);
  }

  // Returns { ok: true, value: { comPort, baudRate, stationKey } } or
  // { ok: false, errors: [...] } (every problem at once, in plain language).
  // `platform` exists for the automated tests; it defaults to the running
  // platform where there is one.
  function validateConnectionSettings(input, { platform } = {}) {
    const raw = input && typeof input === 'object' ? input : {};
    const errors = [];
    const os = platform || (typeof process !== 'undefined' && process.platform) || 'win32';

    const trimmed = String(raw.comPort == null ? '' : raw.comPort).trim();
    const portValue = os === 'win32' ? trimmed.toUpperCase() : trimmed;
    const portPattern = os === 'win32' ? PORT_PATTERNS.win32 : PORT_PATTERNS.other;
    if (!portPattern.test(portValue)) {
      errors.push(os === 'win32' ? 'The COM port must look like COM1 to COM999.' : 'The port must be a /dev/tty.* or /dev/cu.* device.');
    }

    const baudRate = Number(raw.baudRate);
    if (!BAUD_RATES.includes(baudRate)) {
      errors.push(`The baud rate must be one of ${BAUD_RATES.join(', ')}.`);
    }

    const stationKey = String(raw.stationKey == null ? '' : raw.stationKey);
    if (!isStationKey(stationKey)) {
      errors.push('Choose one of the listed stations.');
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: { comPort: portValue, baudRate, stationKey } };
  }

  return { STATION_GROUPS, STATIONS, BAUD_RATES, DEFAULT_BAUD_RATE, isStationKey, validateConnectionSettings };
});

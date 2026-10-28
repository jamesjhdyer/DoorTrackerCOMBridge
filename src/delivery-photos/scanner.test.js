'use strict';

// The iPad's scanner (delivery-photos-web/scanner.js) run here, in Node, on
// real generated Data Matrix and QR Code images, with the same zxing-wasm
// reader the iPad uses - then the decoded text through the same role check
// the iPad and the PC use (photo-roles.js). Proves the two code formats give
// exactly the same result for every role, and that the format itself plays
// no part in it. (The real-browser end-to-end version, camera included, is
// in offline-browser.test.js.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');
const vm = require('node:vm');
const { PNG } = require('pngjs');

const Roles = require('./photo-roles');

const SCANNER_JS = nodePath.join(__dirname, '..', '..', 'delivery-photos-web', 'scanner.js');

let scannerPromise = null;
// scanner.js exactly as the iPad loads it (a plain <script>), with the npm
// zxing-wasm reader standing in for the vendored IIFE copy of the same
// version. prepareZXingModule() is a no-op here: in Node the reader finds
// its own .wasm in node_modules, not at the iPad's /vendor/zxing/ path.
function loadScanner() {
  if (!scannerPromise) {
    scannerPromise = import('zxing-wasm/reader').then((reader) => {
      const sandbox = { ZXingWASM: { prepareZXingModule() {}, readBarcodes: reader.readBarcodes }, setInterval, clearInterval };
      vm.createContext(sandbox);
      vm.runInContext(`${fs.readFileSync(SCANNER_JS, 'utf8')}\nthis.DeliveryPhotoScanner = DeliveryPhotoScanner;`, sandbox);
      return sandbox.DeliveryPhotoScanner;
    });
  }
  return scannerPromise;
}

// A generated code, drawn with a white margin onto a larger "camera frame",
// as RGBA pixels.
async function codeFrame(format, text, scale = 8) {
  const { writeBarcode } = await import('zxing-wasm/writer');
  const result = await writeBarcode(text, { format, scale });
  assert.equal(result.error, '', `could not generate a ${format} for ${text}`);
  const code = PNG.sync.read(Buffer.from(await result.image.arrayBuffer()));
  const margin = 60;
  const width = code.width + margin * 2;
  const height = code.height + margin * 2;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < code.height; y++) {
    for (let x = 0; x < code.width; x++) {
      const from = (y * code.width + x) * 4;
      const to = ((y + margin) * width + x + margin) * 4;
      for (let c = 0; c < 4; c++) data[to + c] = code.data[from + c];
    }
  }
  return { data, width, height };
}

// Just enough of a <video> and a <canvas> for scanFrame(): the "video" has a
// frame size, and drawing it onto the canvas makes these pixels readable.
async function scan(format, text, scale) {
  const scanner = await loadScanner();
  const frame = await codeFrame(format, text, scale);
  const video = { videoWidth: frame.width, videoHeight: frame.height };
  const canvas = {
    getContext: () => ({
      drawImage() {},
      getImageData: (x, y, w, h) => {
        assert.deepEqual([w, h], [frame.width, frame.height], 'a frame this small is decoded at its own size');
        return frame;
      }
    })
  };
  return scanner.scanFrame(video, canvas);
}

const FORMATS = ['DataMatrix', 'QRCode'];

test('the scanner looks for exactly two formats: Data Matrix and QR Code', async () => {
  const scanner = await loadScanner();
  assert.deepEqual([...scanner.FORMATS], FORMATS);
});

const ACCEPTED = {
  delivery: ['5698-DELIV', '5698-P-DELIV', '5698-P2-DELIV', '5626-2-P3-DELIV'],
  bench: ['5698-D-01', '5698-F-07', '5626-2-D-01', '5626-2-F-03'],
  ironmongery: ['5698', '5626-2']
};

for (const [role, codes] of Object.entries(ACCEPTED)) {
  test(`${role}: every code reads the same from a Data Matrix and a QR Code, and parses exactly as if typed`, async () => {
    for (const text of codes) {
      const typed = Roles.parseForRole(role, text);
      assert.equal(typed.ok, true, `${text} is a valid ${role} code`);
      for (const format of FORMATS) {
        const decoded = await scan(format, text);
        assert.equal(decoded, text, `${format} ${text} decodes`);
        // Same role, same code, same order folder, same delivery details -
        // so the same file names and tracking downstream.
        assert.deepEqual(Roles.parseForRole(role, decoded), typed, `${format} ${text} on a ${role} iPad`);
      }
    }
  });
}

test('a code meant for another role is refused whichever format it is in', async () => {
  const cases = [
    ['bench', '5698-DELIV'],
    ['bench', '5698'],
    ['delivery', '5698-D-01'],
    ['delivery', '5626-2'],
    ['ironmongery', '5698-DELIV'],
    ['ironmongery', '5626-2-F-03']
  ];
  for (const [role, text] of cases) {
    const typed = Roles.parseForRole(role, text);
    assert.equal(typed.ok, false, `${text} is not a ${role} code`);
    for (const format of FORMATS) {
      const decoded = await scan(format, text);
      assert.equal(decoded, text);
      assert.deepEqual(Roles.parseForRole(role, decoded), typed, `${format} ${text} refused on a ${role} iPad, with the same reason as typed`);
    }
  }
});

test('a QR Code with text that is no valid code at all is refused for every role', async () => {
  for (const text of ['HELLO', 'https://example.com/5698-DELIV', '5698-DELIV-EXTRA', '5698-D-00']) {
    const decoded = await scan('QRCode', text);
    assert.equal(decoded, text);
    for (const role of Roles.ROLE_KEYS) assert.equal(Roles.parseForRole(role, decoded).ok, false, `QR "${text}" refused on a ${role} iPad`);
  }
});

test('other barcode formats are not decoded at all', async () => {
  for (const format of ['Code128', 'Aztec', 'PDF417']) assert.equal(await scan(format, '5698-DELIV', 3), null, `${format} is ignored`);
});

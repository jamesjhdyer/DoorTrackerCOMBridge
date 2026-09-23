// Data Matrix scanning, entirely in the browser, entirely offline.
//
// Safari on iPad has no BarcodeDetector API at all (confirmed before writing
// this), so decoding is done by zxing-wasm (a WebAssembly build of the real
// zxing-cpp engine - see vendor/zxing/README.txt for why it is vendored
// locally rather than loaded from a CDN).
//
// Rather than decoding the live video stream continuously (a known source of
// bugs in some JS barcode libraries, and unnecessary once a code has been
// found), this grabs and decodes ONE still frame at a time, on a plain
// interval - see startScanning() below.
'use strict';

const DeliveryPhotoScanner = (() => {
  let modulePrepared = false;

  // Where zxing_reader.wasm was vendored to (see vendor/zxing/README.txt) -
  // a fixed, absolute path rather than trusting the library's own "detect my
  // script's own directory" logic: confirmed by a real headless-browser
  // check that detection resolves to an empty prefix for an IIFE <script>
  // loaded this way, which silently sent the request to the SITE ROOT
  // instead (a 404 for /zxing_reader.wasm, not /vendor/zxing/zxing_reader.wasm).
  const WASM_DIR = '/vendor/zxing/';

  function ensureModulePrepared() {
    if (modulePrepared) return;
    // Force the .wasm binary to always be fetched from the known local path -
    // never the library's own default (a jsDelivr CDN URL), which would
    // silently fail (or silently phone home) the moment there is no internet.
    ZXingWASM.prepareZXingModule({ overrides: { locateFile: (path) => WASM_DIR + path } });
    modulePrepared = true;
  }

  // Grabs the CURRENT frame from `video` via a reusable offscreen canvas and
  // tries to decode a Data Matrix code from it. Returns the decoded text, or
  // null if none was found in this frame. A modest working size (this does
  // not need to be full sensor resolution - it only has to be legible)
  // keeps each decode fast enough to run several times a second.
  async function scanFrame(video, canvas) {
    if (!video.videoWidth || !video.videoHeight) return null;
    const maxEdge = 900;
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);

    ensureModulePrepared();
    const results = await ZXingWASM.readBarcodes(imageData, { formats: ['DataMatrix'], tryHarder: true, maxNumberOfSymbols: 1 });
    return results.length > 0 ? results[0].text : null;
  }

  // Scans `video` on a plain interval until a Data Matrix code is found (or
  // stop() is called first) - never faster than one decode at a time, so a
  // slow frame can never pile up behind another. onFound is called at most
  // once; scanning then stops automatically, matching "stop scanning once a
  // valid delivery has been identified" - callers restart it explicitly
  // (see app.js's "scan a different code" action) rather than it looping forever.
  function startScanning(video, canvas, { intervalMs = 300, onFound, onError } = {}) {
    let stopped = false;
    let busy = false;

    const timer = setInterval(async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const text = await scanFrame(video, canvas);
        if (text && !stopped) {
          stopped = true;
          clearInterval(timer);
          onFound(text);
        }
      } catch (err) {
        if (onError) onError(err);
      } finally {
        busy = false;
      }
    }, intervalMs);

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      }
    };
  }

  return { scanFrame, startScanning };
})();

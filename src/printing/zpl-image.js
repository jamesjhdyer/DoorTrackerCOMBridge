// Pure-JavaScript PNG -> ZPL conversion. No native dependencies, no
// platform-specific code — this file works identically on macOS (where
// it's developed/tested) and Windows (where it actually gets used), which
// is deliberate: everything about "what does the label image data become"
// is ordinary, portable JS, and only the final "send these bytes to a
// Windows printer queue" step (windows-printer.js) is platform-specific.
//
// This module does NOT know or care about order/label business logic — it
// takes whatever PNG bytes and physical dimensions it's given and produces
// ZPL that reproduces that image, nothing more. Label design stays entirely
// the website's responsibility.

const { PNG } = require('pngjs');

const MM_PER_INCH = 25.4;

function mmToDots(mm, dpi) {
  return Math.max(1, Math.round((mm * dpi) / MM_PER_INCH));
}

// Downsamples an RGBA source image to a 1-bit-per-pixel monochrome bitmap
// at the target pixel dimensions, using block-averaging (each target pixel
// = the average luminance of the corresponding block of source pixels,
// thresholded to black/white). Appropriate for shrinking a label rendered
// at a higher DPI (the website renders at 600dpi) down to the printer's
// native 203dpi — direct-thermal printing has no grayscale, so a hard
// black/white decision has to happen somewhere; doing it here, with
// area-averaging rather than nearest-neighbor sampling, keeps thin text/
// Data Matrix modules from disappearing or aliasing badly when shrunk.
function downsampleToMonochromeBitmap(png, targetWidthPx, targetHeightPx, threshold = 128) {
  const { width: srcW, height: srcH, data } = png; // data: RGBA, 4 bytes/pixel, row-major

  const bytesPerRow = Math.ceil(targetWidthPx / 8);
  const bitmap = Buffer.alloc(bytesPerRow * targetHeightPx, 0); // bit=1 means BLACK (printed dot)

  for (let ty = 0; ty < targetHeightPx; ty++) {
    const srcYStart = Math.floor((ty * srcH) / targetHeightPx);
    const srcYEnd = Math.max(srcYStart + 1, Math.floor(((ty + 1) * srcH) / targetHeightPx));

    for (let tx = 0; tx < targetWidthPx; tx++) {
      const srcXStart = Math.floor((tx * srcW) / targetWidthPx);
      const srcXEnd = Math.max(srcXStart + 1, Math.floor(((tx + 1) * srcW) / targetWidthPx));

      let sum = 0;
      let count = 0;
      for (let sy = srcYStart; sy < srcYEnd && sy < srcH; sy++) {
        for (let sx = srcXStart; sx < srcXEnd && sx < srcW; sx++) {
          const idx = (sy * srcW + sx) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const a = data[idx + 3];
          // Composite against a white background before taking luminance —
          // label PNGs are opaque white already, but a transparent source
          // shouldn't silently print as solid black.
          const alpha = a / 255;
          const lum = (r * 0.299 + g * 0.587 + b * 0.114) * alpha + 255 * (1 - alpha);
          sum += lum;
          count++;
        }
      }

      const avgLum = count > 0 ? sum / count : 255;
      if (avgLum < threshold) {
        const byteIndex = ty * bytesPerRow + (tx >> 3);
        bitmap[byteIndex] |= 0x80 >> (tx & 7);
      }
    }
  }

  return { bitmap, bytesPerRow };
}

// ZPL's ^GFA field: uncompressed ASCII-hex graphic data. Chosen over the
// more compact binary (^GFB) / compressed (Z64) forms deliberately — the
// whole label document stays plain ASCII text end to end (no embedded
// control/binary bytes to worry about surviving a temp-file round trip or
// a PowerShell argument), at the cost of a larger payload that's a
// complete non-issue at this label size/print frequency.
function bitmapToGraphicField(bitmap, bytesPerRow) {
  const totalBytes = bitmap.length;
  const hex = bitmap.toString('hex').toUpperCase();
  return `^GFA,${totalBytes},${totalBytes},${bytesPerRow},${hex}`;
}

function assembleLabelZpl({ widthDots, heightDots, graphicField }) {
  return ['^XA', '^MTD', `^PW${widthDots}`, `^LL${heightDots}`, '^FO0,0', graphicField, '^XZ', ''].join('\n');
}

// Converts one label's PNG bytes into a complete, ready-to-submit ZPL
// label ("^XA ... ^XZ"). widthMm/heightMm come from the print job (the
// website's PRINT_PROFILES-configured size, e.g. 89x36mm today) — never
// hard-coded here, so a future profile size change is handled automatically.
function pngBufferToZplLabel(pngBuffer, { widthMm, heightMm, dpi }) {
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
    throw new Error('No image data supplied.');
  }
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new Error(`Invalid label dimensions: ${widthMm}mm x ${heightMm}mm.`);
  }
  if (!(dpi > 0)) {
    throw new Error(`Invalid dpi: ${dpi}.`);
  }

  let png;
  try {
    png = PNG.sync.read(pngBuffer);
  } catch (err) {
    throw new Error(`Failed to decode label image: ${err.message}`);
  }

  const widthDots = mmToDots(widthMm, dpi);
  const heightDots = mmToDots(heightMm, dpi);

  const { bitmap, bytesPerRow } = downsampleToMonochromeBitmap(png, widthDots, heightDots);
  const graphicField = bitmapToGraphicField(bitmap, bytesPerRow);

  return assembleLabelZpl({ widthDots, heightDots, graphicField });
}

// A simple, bridge-generated calibration pattern — a border inset from
// each edge plus a centered crosshair — for verifying physical label size
// and feed on real stock. Deliberately NOT an attempt at the real delivery
// label's look (no order number, no "-DELIV" text, no Data Matrix): this
// is a diagnostic pattern, not a recreation of the website's label design.
function buildTestPatternZpl({ widthMm, heightMm, dpi }) {
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new Error(`Invalid label dimensions: ${widthMm}mm x ${heightMm}mm.`);
  }

  const widthDots = mmToDots(widthMm, dpi);
  const heightDots = mmToDots(heightMm, dpi);
  const insetDots = mmToDots(2, dpi);

  const boxWidth = Math.max(1, widthDots - insetDots * 2);
  const boxHeight = Math.max(1, heightDots - insetDots * 2);
  const thickness = Math.max(1, Math.round(dpi / 100)); // ~0.25mm line weight

  const lines = [
    '^XA',
    '^MTD',
    `^PW${widthDots}`,
    `^LL${heightDots}`,
    // Border rectangle
    `^FO${insetDots},${insetDots}^GB${boxWidth},${boxHeight},${thickness}^FS`,
    // Crosshair through the center
    `^FO${insetDots},${Math.round(heightDots / 2)}^GB${boxWidth},${thickness},${thickness}^FS`,
    `^FO${Math.round(widthDots / 2)},${insetDots}^GB${thickness},${boxHeight},${thickness}^FS`,
    // Human-readable dimensions, using ZPL's own font (no image needed)
    `^FO${insetDots + thickness + 10},${insetDots + thickness + 10}^A0N,28,28^FDTEST ${widthMm}x${heightMm}mm^FS`,
    '^XZ',
    ''
  ];
  return lines.join('\n');
}

module.exports = { mmToDots, pngBufferToZplLabel, buildTestPatternZpl };

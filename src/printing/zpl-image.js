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

// Same conversion as mmToDots but signed (no floor of 1), for offsets that
// can legitimately be negative or zero — a size can't be, but a shift can.
function mmToDotsSigned(mm, dpi) {
  return Math.round((mm * dpi) / MM_PER_INCH);
}

// Physical home-offset correction for the GK420D, confirmed from a printed
// 89x36mm test pattern: the printed content landed consistently ~1mm to
// the right of where the ZPL canvas places it (left margin measured ~1mm
// wider than designed, right margin ~1mm narrower), while the vertical
// start position was already correct ("aligned correctly at the top").
// That's the label/printhead centering ^LS (Label Shift) exists to
// compensate for, and it's a characteristic of this printer+media
// combination, not of any one label design — so it's applied wherever ZPL
// gets assembled (both the diagnostic test pattern and real delivery
// labels), rather than only in the test pattern. Re-tune this constant
// (from a fresh physical test print) if the printer or media stock changes.
const LABEL_SHIFT_X_MM = -1;

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

function assembleLabelZpl({ widthDots, heightDots, graphicField, dpi }) {
  const shiftDots = mmToDotsSigned(LABEL_SHIFT_X_MM, dpi);
  return ['^XA', '^MTD', `^PW${widthDots}`, `^LL${heightDots}`, `^LS${shiftDots}`, '^FO0,0', graphicField, '^XZ', ''].join('\n');
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

  return assembleLabelZpl({ widthDots, heightDots, graphicField, dpi });
}

// A simple, bridge-generated calibration pattern — a border inset from
// each edge plus a centered crosshair — for verifying physical label size
// and feed on real stock. Deliberately NOT an attempt at the real delivery
// label's look (no order number, no "-DELIV" text, no Data Matrix): this
// is a diagnostic pattern, not a recreation of the website's label design.
//
// Alignment note: a physical 89x36mm print of this pattern showed the top
// landing correctly but ~3mm blank at the bottom (vs. ~5mm/~1mm on
// left/right before the LABEL_SHIFT_X_MM fix above). Unlike the horizontal
// case, this isn't a simple shift — the top being already correct means
// shifting vertically would only trade top accuracy for bottom accuracy.
// It smells like this GK420D's own label-length/gap calibration for this
// media running slightly long, which isn't something safe to guess-correct
// by inflating ^LL here: get it wrong and a taller-than-physical label
// canvas can drift the *next* label's registration. If it's still short
// after a reprint, recalibrate the printer for this stock (or empirically
// raise the height in the Test label size (mm) field above to find the
// true usable length) rather than padding this function further.
function buildTestPatternZpl({ widthMm, heightMm, dpi }) {
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new Error(`Invalid label dimensions: ${widthMm}mm x ${heightMm}mm.`);
  }

  const widthDots = mmToDots(widthMm, dpi);
  const heightDots = mmToDots(heightMm, dpi);
  // Cosmetic margin between the border and the label's physical edge —
  // shrunk from a prior 2mm to 1mm so the pattern uses as much of the
  // physical label as the GK420D allows while still leaving the border
  // visibly inset (a literal 0-inset border risks printing right at/past
  // the die-cut edge, where thermal printers commonly can't render
  // reliably anyway).
  const insetDots = mmToDots(1, dpi);

  const boxWidth = Math.max(1, widthDots - insetDots * 2);
  const boxHeight = Math.max(1, heightDots - insetDots * 2);
  const thickness = Math.max(1, Math.round(dpi / 100)); // ~0.25mm line weight
  const shiftDots = mmToDotsSigned(LABEL_SHIFT_X_MM, dpi);

  const lines = [
    '^XA',
    '^MTD',
    `^PW${widthDots}`,
    `^LL${heightDots}`,
    `^LS${shiftDots}`,
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

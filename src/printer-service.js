// Physical printer output for the Zebra GK420D (203dpi direct thermal, USB).
//
// This is the ONLY place that knows about ZPL/GK420D specifics; nothing
// upstream (print-job-processor.js) knows or cares HOW printing happens —
// it just calls printJob(job) and reacts to success/rejection. That
// boundary is unchanged from the stub this replaces.
//
// Flow: validate the job -> validate a printer is configured -> validate
// that printer actually exists on Windows right now -> convert each
// label's PNG to ZPL at the job's own widthMm/heightMm (never hard-coded)
// -> submit the concatenated ZPL for the whole job as one raw print
// submission. See printing/zpl-image.js (pure JS, platform-independent)
// and printing/windows-printer.js (Windows-only submission/enumeration).

const { pngBufferToZplLabel } = require('./printing/zpl-image');
const windowsPrinter = require('./printing/windows-printer');
const printerSettings = require('./printer-settings');

const GK420D_DPI = 203;

function validateJob(job) {
  if (!job || typeof job !== 'object') {
    throw new Error('No print job supplied.');
  }
  const { jobId, widthMm, heightMm, labels } = job;
  if (!jobId) {
    throw new Error('Print job is missing a job id.');
  }
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new Error(`Job ${jobId}: invalid label dimensions ${widthMm}mm x ${heightMm}mm.`);
  }
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error(`Job ${jobId}: no labels to print.`);
  }
  return job;
}

async function validatePrinterConfigured() {
  const printerName = printerSettings.getPrinterName();
  if (!printerName) {
    throw new Error('No printer is configured. Select the Zebra GK420D in the Printer settings before printing.');
  }
  return printerName;
}

async function validatePrinterExists(printerName) {
  const status = await windowsPrinter.getPrinterStatus(printerName);
  if (!status.supported) {
    throw new Error(
      `Cannot access Windows printers on this platform (${process.platform}) — physical printing is only implemented for Windows.`
    );
  }
  if (!status.found) {
    throw new Error(`Configured printer "${printerName}" was not found on this PC. Is it installed and connected?`);
  }
  if (status.offline) {
    throw new Error(`Printer "${printerName}" is reporting offline/disconnected.`);
  }
}

// Converts every label in the job to ZPL and concatenates them into a
// single document — ZPL processes each ^XA...^XZ block in sequence, so
// this prints all of a job's labels, in order, as one spooler submission
// rather than one submission per label. Today's DELIVERY_STANDARD profile
// only ever supplies one label, but nothing here assumes that.
function buildJobZpl(job) {
  const sortedLabels = [...job.labels].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  return sortedLabels
    .map((label) => {
      if (!label || !label.labelKey) {
        throw new Error(`Job ${job.jobId}: a label entry is missing its labelKey.`);
      }
      if (!label.imageBase64) {
        throw new Error(`Job ${job.jobId}: label "${label.labelKey}" has no image data.`);
      }

      let pngBuffer;
      try {
        pngBuffer = Buffer.from(label.imageBase64, 'base64');
      } catch (err) {
        throw new Error(`Job ${job.jobId}: label "${label.labelKey}" has invalid base64 image data: ${err.message}`);
      }
      if (pngBuffer.length === 0) {
        throw new Error(`Job ${job.jobId}: label "${label.labelKey}" decoded to empty image data.`);
      }

      try {
        return pngBufferToZplLabel(pngBuffer, { widthMm: job.widthMm, heightMm: job.heightMm, dpi: GK420D_DPI });
      } catch (err) {
        throw new Error(`Job ${job.jobId}: failed to convert label "${label.labelKey}" to ZPL: ${err.message}`);
      }
    })
    .join('');
}

/**
 * @param {{ jobId: string, widthMm: number, heightMm: number, labels: Array<{labelKey: string, sequence?: number, imageBase64: string}> }} job
 * @returns {Promise<void>} Resolves once Windows has accepted the raw print
 *   submission for every label in the job — see this module's own comment
 *   and the report for exactly what that does/doesn't prove about physical
 *   output. Rejects with a specific, useful message on any validation or
 *   submission failure.
 */
async function printJob(job) {
  validateJob(job);

  const printerName = await validatePrinterConfigured();
  await validatePrinterExists(printerName);

  const zpl = buildJobZpl(job);

  try {
    await windowsPrinter.sendRawData(printerName, Buffer.from(zpl, 'ascii'));
  } catch (err) {
    throw new Error(`Job ${job.jobId}: failed to submit to printer "${printerName}": ${err.message}`);
  }
}

module.exports = { printJob };

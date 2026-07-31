// HTTP client for the website's print-job endpoints (status reporting +
// pending-job recovery). Separate from the existing scan-posting logic in
// main.js — same fetch+timeout pattern, different concern, and this way
// print-job-processor.js doesn't need to know anything about COM
// ports/tabs to make these calls.

const API_TIMEOUT_MS = 8000;

// The website's print-job endpoints (POST /api/print-jobs/:jobId/status,
// GET /api/print-jobs/pending) live on the same origin as the existing
// scan endpoint, just a different path — e.g. an apiUrl of
// "https://your-app.example.com/api/com-scans" gives an apiBase of
// "https://your-app.example.com". No separate setting for this is
// introduced; it's derived every time it's needed instead, so the two
// stay in sync automatically if the configured URL is ever changed.
function deriveApiBase(comScansApiUrl) {
  try {
    return new URL(comScansApiUrl).origin;
  } catch {
    return null;
  }
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return { ok: false, error: (data && data.error) || `HTTP ${response.status} ${response.statusText}` };
    }
    return { ok: true, data };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Request timed out' : err.message;
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Reports a status transition for a job. Never throws — a failure to
// report is returned as { ok: false, error }, not raised, since the caller
// (print-job-processor.js) must still proceed with the actual physical
// print attempt regardless of whether this report itself lands; reporting
// is best-effort telemetry/recovery bookkeeping, not a gate on printing.
async function reportJobStatus(apiBase, jobId, status, message) {
  if (!apiBase) return { ok: false, error: 'No API URL configured.' };

  return fetchJson(`${apiBase}/api/print-jobs/${encodeURIComponent(jobId)}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, message })
  });
}

// Fetches unfinished (QUEUED/CLAIMED/PRINTING) jobs for one station — see
// GET /api/print-jobs/pending in the website project. Called on every
// successful COM-port connection (see main.js), regardless of which
// station that tab is configured for — the website itself is what decides
// which stations ever have print jobs at all, so this file (and the rest
// of the bridge) never needs to hard-code which station is special.
async function fetchPendingJobs(apiBase, stationKey) {
  if (!apiBase) return { ok: false, error: 'No API URL configured.', jobs: [] };

  const result = await fetchJson(
    `${apiBase}/api/print-jobs/pending?station_key=${encodeURIComponent(stationKey || '')}`,
    { method: 'GET' }
  );

  if (!result.ok) {
    return { ok: false, error: result.error, jobs: [] };
  }
  return { ok: true, jobs: (result.data && result.data.jobs) || [] };
}

// Requests a deliberate reprint of an existing job — see
// POST /api/print-jobs/:jobId/reprint in the website project (built
// alongside the persistent per-delivery-code dedupe specifically as the
// "intentional extra copy" escape hatch). Used by the manual printer-test
// panel to print a REAL, website-rendered delivery label on demand,
// without needing a real production scan — this calls existing website
// functionality rather than the bridge recreating any label content itself.
async function reprintJob(apiBase, jobId) {
  if (!apiBase) return { ok: false, error: 'No API URL configured.' };

  const result = await fetchJson(`${apiBase}/api/print-jobs/${encodeURIComponent(jobId)}/reprint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'combridge_manual_test' })
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, job: result.data && result.data.printJob };
}

module.exports = { deriveApiBase, reportJobStatus, fetchPendingJobs, reprintJob };

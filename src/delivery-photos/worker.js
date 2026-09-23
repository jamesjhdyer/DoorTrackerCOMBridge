'use strict';

// Entry point of the short-lived process that does the network-drive work. The
// parent sends ONE message { op, params }, gets ONE answer, and this process exits.
// If the network share hangs, the parent kills this process; nothing else is affected.

const archive = require('./archive');
const { testNetworkStorage } = require('./storage-test');

const OPERATIONS = {
  probe: archive.probeRoot,
  archive: archive.archivePhoto,
  sweep: archive.sweepIncoming,
  'storage-test': testNetworkStorage
};

// Test-only failure injection, honoured ONLY when DELIVERY_PHOTOS_TEST_HOOKS=1 is set.
// 'hang' never answers; 'crash-after-rename' dies right after the photograph is
// renamed into place, before anything is reported.
function hooksFor(testMode) {
  if (process.env.DELIVERY_PHOTOS_TEST_HOOKS !== '1') return {};
  if (testMode === 'hang') return { hang: true };
  if (testMode === 'crash-after-rename') return { afterPublish: () => process.exit(9) };
  return {};
}

function reply(message) {
  process.send(message, () => process.exit(0));
}

process.on('message', async (message) => {
  try {
    const operation = message && OPERATIONS[message.op];
    if (!operation) throw new Error('unknown operation');
    const hooks = hooksFor(message.testMode);
    if (hooks.hang) await new Promise(() => {});
    reply({ ok: true, result: await operation(message.params, hooks) });
  } catch (err) {
    reply({ ok: false, error: { code: err && err.code, name: err && err.name, message: err && err.message } });
  }
});

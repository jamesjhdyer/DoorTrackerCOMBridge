// The iPad's own offline queue: delivery photo sessions that could not be
// sent to the Windows Photo Service at the time (the iPad was away from the
// workshop Wi-Fi, the PC was off, pairing had been reset...) are kept here,
// in this site's own IndexedDB, until they can be.
//
// Like reference.js, this one file works unchanged in the browser (a plain
// <script>, exposing window.DeliveryOfflineQueue) and in Node (require()) -
// the automated tests drive exactly this code, with a fake IndexedDB and a
// fake or real Photo Service behind the injected `api`.
//
// Rules this file enforces:
//   - A session is only reported as "saved on this iPad" once every photo
//     has been written AND read back with a matching size and SHA-256.
//   - A queued photo is the exact same JPEG bytes that would have been
//     uploaded straight away - never re-encoded or resized.
//   - The session is only removed from this iPad once every photo has come
//     back 201 (saved and read back off the company drive by the PC) AND the
//     PC has acknowledged the session-complete report. Nothing is deleted on
//     a failure, a lost connection, or a pairing problem.
//   - Records hold only delivery metadata and photographs: never the pairing
//     token, network paths, or any credential.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DeliveryOfflineQueue = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DB_NAME = 'delivery-photos-offline';
  const DB_VERSION = 1;
  const SESSIONS = 'sessions';
  const PHOTOS = 'photos';

  // Session status values, as stored.
  const STATUS = {
    PENDING: 'pending', // waiting to send (also what an interrupted 'syncing' is treated as)
    SYNCING: 'syncing', // a send attempt is in progress (or was, when the page was closed)
    FAILED: 'failed', // the last attempt reached the PC but did not fully succeed
    NEEDS_PAIRING: 'needs_pairing' // the PC rejected this iPad's pairing token
  };

  // Above this fraction of the browser's own quota, the person is warned.
  const HIGH_USAGE_FRACTION = 0.8;
  // Room kept spare on top of a new session's own photo bytes when deciding
  // whether it fits (IndexedDB bookkeeping, plus not running the origin's
  // storage right up to the edge, where Safari starts refusing writes).
  const SAFETY_MARGIN_FRACTION = 0.1;
  const SAFETY_MARGIN_MIN_BYTES = 20 * 1000 * 1000;

  // ---- helpers ------------------------------------------------------------

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Resolves only once the transaction has COMMITTED - not merely once its
  // requests succeeded - so "saved" really means durable.
  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('The save was aborted.'));
      tx.onerror = () => reject(tx.error || new Error('The save failed.'));
    });
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // The same Full/Part mapping the Windows app's tracking.js uses for the
  // Google Sheet, from reference.js's parsed result.
  function deliveryMetadata(parsed) {
    return {
      reference: parsed.reference,
      orderNumber: parsed.orderNumber,
      deliveryType: parsed.type === 'part' ? 'Part Delivery' : 'Full Delivery',
      partNo: parsed.type === 'part' ? parsed.partNumber : ''
    };
  }

  // ---- storage --------------------------------------------------------------

  // Opens (creating on first use) this origin's offline queue database.
  // `indexedDB` is injected so tests can supply a fake one.
  function openStore({ indexedDB, name = DB_NAME } = {}) {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
      if (!db.objectStoreNames.contains(PHOTOS)) {
        const photos = db.createObjectStore(PHOTOS, { keyPath: 'photoId' });
        photos.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    return requestToPromise(request).then((db) => createStore(db));
  }

  function createStore(db) {
    // Strictly increasing, even for two sessions saved within the same
    // millisecond, so "oldest first" is always well defined.
    let lastQueueOrder = 0;

    async function getPhotos(sessionId) {
      const tx = db.transaction(PHOTOS, 'readonly');
      const photos = await requestToPromise(tx.objectStore(PHOTOS).index('sessionId').getAll(sessionId));
      return photos.sort((a, b) => a.position - b.position);
    }

    async function getSession(sessionId) {
      const tx = db.transaction(SESSIONS, 'readonly');
      return (await requestToPromise(tx.objectStore(SESSIONS).get(sessionId))) || null;
    }

    // Writes one whole delivery session - its metadata and every photo - in a
    // SINGLE transaction (all or nothing: a full iPad or a crash can never
    // leave half a session behind), then reads every photo back and checks it.
    // `photos`: [{ photoId, bytes (ArrayBuffer), sha256?, width, height,
    // capturedAt, uploaded? }] in shooting order. A photo already uploaded
    // (the online path got partway, or all the way) needs no bytes at all.
    async function saveSession(session, photos) {
      const now = new Date().toISOString();
      const prepared = [];
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        const uploaded = Boolean(p.uploaded);
        const bytes = uploaded ? null : p.bytes;
        if (!uploaded && !(bytes instanceof ArrayBuffer && bytes.byteLength > 0)) throw new Error('A photograph has no data to save.');
        prepared.push({
          photoId: p.photoId,
          sessionId: session.sessionId,
          position: i,
          bytes,
          sizeBytes: uploaded ? p.sizeBytes || 0 : bytes.byteLength,
          sha256: uploaded ? p.sha256 || '' : p.sha256 || (await sha256Hex(bytes)),
          width: p.width || 0,
          height: p.height || 0,
          capturedAt: p.capturedAt || now,
          uploaded,
          uploadedAt: uploaded ? p.uploadedAt || now : ''
        });
      }

      const record = {
        sessionId: session.sessionId,
        reference: session.reference,
        orderNumber: session.orderNumber,
        deliveryType: session.deliveryType,
        partNo: session.partNo,
        photoCount: prepared.length,
        totalBytes: prepared.reduce((sum, p) => sum + (p.bytes ? p.bytes.byteLength : 0), 0),
        capturedAt: session.capturedAt || (prepared[0] && prepared[0].capturedAt) || now,
        createdAt: now,
        queueOrder: (lastQueueOrder = Math.max(Date.now(), lastQueueOrder + 1)),
        status: STATUS.PENDING,
        attempts: 0,
        lastAttemptAt: '',
        lastError: ''
      };

      const tx = db.transaction([SESSIONS, PHOTOS], 'readwrite');
      tx.objectStore(SESSIONS).put(record);
      for (const p of prepared) tx.objectStore(PHOTOS).put(p);
      await transactionDone(tx);

      await verifySession(record.sessionId, prepared);
      return record;
    }

    // Reads every photo of a just-saved session back out of IndexedDB and
    // checks its size and SHA-256 against what was meant to be written. On
    // any mismatch the session is removed again and an error thrown - the
    // caller must then NOT tell the person it was saved.
    async function verifySession(sessionId, expected) {
      const stored = await getPhotos(sessionId);
      const problem = await (async () => {
        if (stored.length !== expected.length) return `expected ${expected.length} photographs, found ${stored.length}`;
        for (let i = 0; i < expected.length; i++) {
          const want = expected[i];
          const got = stored[i];
          if (got.photoId !== want.photoId) return 'photographs out of order';
          if (want.uploaded) continue;
          if (!got.bytes || got.bytes.byteLength !== want.sizeBytes) return `photograph ${i + 1} has the wrong size`;
          if ((await sha256Hex(got.bytes)) !== want.sha256) return `photograph ${i + 1} did not read back correctly`;
        }
        return '';
      })();
      if (problem) {
        await deleteSession(sessionId).catch(() => {});
        throw new Error(`Could not save on this iPad (${problem}).`);
      }
    }

    async function listSessions() {
      const tx = db.transaction(SESSIONS, 'readonly');
      const sessions = await requestToPromise(tx.objectStore(SESSIONS).getAll());
      return sessions.sort((a, b) => (a.queueOrder || 0) - (b.queueOrder || 0) || a.createdAt.localeCompare(b.createdAt));
    }

    // Read-modify-write inside ONE transaction, using plain callbacks rather
    // than awaiting between the read and the write: older Safari versions end
    // an IndexedDB transaction early across an await, which would silently
    // drop the write.
    function modifyRecord(storeName, key, change) {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result) store.put(change(request.result));
      };
      return transactionDone(tx);
    }

    function updateSession(sessionId, patch) {
      return modifyRecord(SESSIONS, sessionId, (current) => ({ ...current, ...patch, sessionId }));
    }

    // Marks one photo as saved on the company drive. Its bytes are KEPT until
    // the whole session is acknowledged (see deleteSession) - nothing is
    // thrown away part-way through a session.
    function markPhotoUploaded(photoId) {
      return modifyRecord(PHOTOS, photoId, (current) => ({ ...current, uploaded: true, uploadedAt: new Date().toISOString() }));
    }

    // Removes one session and ONLY its own photos, in one transaction.
    function deleteSession(sessionId) {
      const tx = db.transaction([SESSIONS, PHOTOS], 'readwrite');
      tx.objectStore(SESSIONS).delete(sessionId);
      const photos = tx.objectStore(PHOTOS);
      const request = photos.index('sessionId').getAllKeys(sessionId);
      request.onsuccess = () => {
        for (const key of request.result) photos.delete(key);
      };
      return transactionDone(tx);
    }

    function close() {
      db.close();
    }

    return { saveSession, verifySession, listSessions, getSession, getPhotos, updateSession, markPhotoUploaded, deleteSession, close };
  }

  // ---- storage space --------------------------------------------------------

  // Turns navigator.storage.estimate()'s { usage, quota } into what the UI
  // and the "is there room for this session?" check need. Every limit here
  // comes from the browser's own reported quota - nothing is an arbitrary
  // fixed size. When the browser cannot report a quota at all, nothing is
  // refused on that basis (the write itself will still fail cleanly, as one
  // transaction, if storage really is full).
  function assessStorage(estimate, neededBytes = 0) {
    const usage = estimate && Number.isFinite(estimate.usage) ? estimate.usage : null;
    const quota = estimate && Number.isFinite(estimate.quota) && estimate.quota > 0 ? estimate.quota : null;
    if (usage === null || quota === null) {
      return { known: false, usedBytes: usage, quotaBytes: quota, availableBytes: null, fraction: null, high: false, canStore: true, reason: '' };
    }
    const availableBytes = Math.max(0, quota - usage);
    const fraction = usage / quota;
    const margin = Math.max(SAFETY_MARGIN_MIN_BYTES, neededBytes * SAFETY_MARGIN_FRACTION);
    const canStore = neededBytes + margin <= availableBytes;
    return {
      known: true,
      usedBytes: usage,
      quotaBytes: quota,
      availableBytes,
      fraction,
      high: fraction >= HIGH_USAGE_FRACTION,
      canStore,
      reason: canStore ? '' : 'There is not enough storage space left on this iPad to save these photographs offline.'
    };
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return 'unknown';
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
    return `${bytes} bytes`;
  }

  // ---- sending --------------------------------------------------------------

  // The sync engine. `api` talks to the Windows Photo Service and is injected
  // (the browser passes real fetch/XHR calls; tests pass fakes or a Node
  // client for a real test server):
  //   checkService()                         -> { reachable, paired }
  //   uploadPhoto({ reference, photoId, bytes, sha256 })
  //                                          -> { ok } | { ok: false, error, needsPairing?, unreachable? }
  //   completeSession({ sessionId, reference, photosSaved })
  //                                          -> same shape
  // `withLock(fn)` (optional) serialises sending across browser tabs - see
  // app.js, which passes the Web Locks API when the browser has it.
  function createSyncEngine({ store, api, onProgress = () => {}, withLock = (fn) => fn() }) {
    let running = null;

    function progress(update) {
      try {
        onProgress(update);
      } catch {
        // a UI problem must never break sending
      }
    }

    async function failSession(session, status, error) {
      await store.updateSession(session.sessionId, { status, lastError: String(error || '').slice(0, 300) });
    }

    // Sends ONE session: every not-yet-uploaded photo in order, then the
    // session-complete report, then (only then) deletes it locally.
    async function sendSession(session) {
      await store.updateSession(session.sessionId, { status: STATUS.SYNCING, lastAttemptAt: new Date().toISOString(), attempts: (session.attempts || 0) + 1 });
      const photos = await store.getPhotos(session.sessionId);
      if (photos.length === 0) {
        await failSession(session, STATUS.FAILED, 'This delivery has no photographs stored.');
        return { outcome: 'failed' };
      }

      let failure = null;
      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        if (photo.uploaded) continue;
        progress({ sessionId: session.sessionId, reference: session.reference, sending: i + 1, total: photos.length });
        const result = await api.uploadPhoto({ reference: session.reference, photoId: photo.photoId, bytes: photo.bytes, sha256: photo.sha256 });
        if (result.ok) {
          await store.markPhotoUploaded(photo.photoId);
          continue;
        }
        if (result.needsPairing) {
          await failSession(session, STATUS.NEEDS_PAIRING, result.error);
          return { outcome: 'needs_pairing' };
        }
        if (result.unreachable) {
          // Lost the connection part-way: back to plain "waiting", nothing lost.
          await failSession(session, STATUS.PENDING, result.error);
          return { outcome: 'unreachable' };
        }
        // The PC answered but refused or could not file this photo (drive
        // offline, out of space...). Keep going with the rest - they can
        // still be filed - but this session cannot be completed this time.
        failure = failure || result.error;
      }
      if (failure) {
        await failSession(session, STATUS.FAILED, failure);
        return { outcome: 'failed' };
      }

      progress({ sessionId: session.sessionId, reference: session.reference, completing: true });
      const done = await api.completeSession({ sessionId: session.sessionId, reference: session.reference, photosSaved: photos.length });
      if (!done.ok) {
        if (done.needsPairing) {
          await failSession(session, STATUS.NEEDS_PAIRING, done.error);
          return { outcome: 'needs_pairing' };
        }
        await failSession(session, done.unreachable ? STATUS.PENDING : STATUS.FAILED, done.error);
        return { outcome: done.unreachable ? 'unreachable' : 'failed' };
      }

      await store.deleteSession(session.sessionId);
      return { outcome: 'sent' };
    }

    // Sends every queued session, oldest first, one at a time. Stops early
    // (leaving everything still queued) if the Photo Service cannot be
    // reached or this iPad is no longer paired. Overlapping calls share the
    // one run already in progress. Resolves { outcome, sent, failed }:
    // outcome is 'nothing' | 'unreachable' | 'needs_pairing' | 'done' | 'busy'.
    function syncAll({ onlySessionId } = {}) {
      if (running) return running;
      running = (async () => {
        try {
          const result = await withLock(async () => {
            let sessions = await store.listSessions();
            if (onlySessionId) sessions = sessions.filter((s) => s.sessionId === onlySessionId);
            if (sessions.length === 0) return { outcome: 'nothing', sent: 0, failed: 0 };

            const service = await api.checkService();
            if (!service.reachable) return { outcome: 'unreachable', sent: 0, failed: 0 };
            if (!service.paired) {
              for (const s of sessions) await failSession(s, STATUS.NEEDS_PAIRING, 'This iPad needs to be paired again.');
              return { outcome: 'needs_pairing', sent: 0, failed: 0 };
            }

            let sent = 0;
            let failed = 0;
            for (const session of sessions) {
              const r = await sendSession(session);
              if (r.outcome === 'sent') sent++;
              else if (r.outcome === 'failed') failed++;
              else return { outcome: r.outcome, sent, failed };
            }
            return { outcome: 'done', sent, failed };
          });
          return result || { outcome: 'busy', sent: 0, failed: 0 };
        } finally {
          running = null;
          progress(null);
        }
      })();
      return running;
    }

    return { syncAll, isRunning: () => Boolean(running) };
  }

  // ---- when to send -----------------------------------------------------------

  // Foreground-only automatic sending. iPadOS does not reliably run web code
  // in the background, so this never relies on that: it tries when the tool
  // opens, whenever it comes back to the foreground (focus / becoming visible
  // / restored from the back-forward cache), when the browser reports it is
  // back online, and on a gentle timer while the page is visible (switching
  // between Wi-Fi networks does not always fire 'online'). `run` decides for
  // itself whether there is anything to do.
  function installAutoSync({ win, doc, run, intervalMs = 20000 }) {
    const visible = () => !doc || doc.visibilityState !== 'hidden';
    const trigger = (reason) => {
      if (visible()) run(reason);
    };
    const onFocus = () => trigger('focus');
    const onVisibility = () => trigger('visible');
    const onOnline = () => trigger('online');
    const onPageShow = () => trigger('pageshow');
    win.addEventListener('focus', onFocus);
    win.addEventListener('online', onOnline);
    win.addEventListener('pageshow', onPageShow);
    if (doc) doc.addEventListener('visibilitychange', onVisibility);
    const timer = intervalMs > 0 ? setInterval(() => trigger('timer'), intervalMs) : null;
    trigger('open');
    return function uninstall() {
      win.removeEventListener('focus', onFocus);
      win.removeEventListener('online', onOnline);
      win.removeEventListener('pageshow', onPageShow);
      if (doc) doc.removeEventListener('visibilitychange', onVisibility);
      if (timer) clearInterval(timer);
    };
  }

  return { DB_NAME, STATUS, HIGH_USAGE_FRACTION, openStore, deliveryMetadata, sha256Hex, assessStorage, formatBytes, createSyncEngine, installAutoSync };
});

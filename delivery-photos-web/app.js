// The workshop Photos iPad tool. One page, no framework. Each iPad is
// paired as ONE photo role - Delivery, Bench or Ironmongery (see
// photo-roles.js) - chosen on the PC, and the whole tool follows it:
// headings, what it scans, and how its photos are named on the drive.
//   SCAN     - live camera, looking for a Data Matrix code (or a typed code)
//   CAPTURE  - the recognised code and order, live camera, thumbnails, Done
//   RESULT   - filed (every photograph verified on the drive), saved on this
//              iPad (the PC could not be reached - sent later), or partial
//   PENDING  - sessions saved on this iPad, waiting to be sent
//
// Online, Done uploads straight to the Windows Photo Service exactly as
// before. If that service cannot be reached (away from the workshop Wi-Fi,
// PC off, pairing reset), the whole session is saved in this iPad's own
// IndexedDB instead (see offline-queue.js) and sent automatically the next
// time the tool is open in the foreground and the service is reachable.
'use strict';

(() => {
  const els = {
    pairingScreen: document.getElementById('pairing-screen'),
    pairingForm: document.getElementById('pairing-form'),
    pairingCodeInput: document.getElementById('pairing-code-input'),
    pairingError: document.getElementById('pairing-error'),
    pairingBusy: document.getElementById('pairing-busy'),
    scanScreen: document.getElementById('scan-screen'),
    captureScreen: document.getElementById('capture-screen'),
    resultScreen: document.getElementById('result-screen'),
    scanVideo: document.getElementById('scan-video'),
    scanCanvas: document.getElementById('scan-canvas'),
    scanMessage: document.getElementById('scan-message'),
    manualEntryButton: document.getElementById('manual-entry-button'),
    manualEntryForm: document.getElementById('manual-entry-form'),
    manualEntryInput: document.getElementById('manual-entry-input'),
    manualEntryCancel: document.getElementById('manual-entry-cancel'),
    captureVideo: document.getElementById('capture-video'),
    captureCanvas: document.getElementById('capture-canvas'),
    referenceLabel: document.getElementById('reference-label'),
    referenceSub: document.getElementById('reference-sub'),
    shutterButton: document.getElementById('shutter-button'),
    fallbackInput: document.getElementById('fallback-input'),
    thumbnails: document.getElementById('thumbnails'),
    photoCount: document.getElementById('photo-count'),
    doneButton: document.getElementById('done-button'),
    abandonButton: document.getElementById('abandon-button'),
    savingOverlay: document.getElementById('saving-overlay'),
    savingProgress: document.getElementById('saving-progress'),
    resultIcon: document.getElementById('result-icon'),
    resultHeading: document.getElementById('result-heading'),
    resultReference: document.getElementById('result-reference'),
    resultDetail: document.getElementById('result-detail'),
    retryButton: document.getElementById('retry-button'),
    scanNextButton: document.getElementById('scan-next-button'),
    resultWarning: document.getElementById('result-warning'),
    cameraWarning: document.getElementById('camera-warning'),
    pairingSkipButton: document.getElementById('pairing-skip-button'),
    pendingScreen: document.getElementById('pending-screen'),
    pendingBackButton: document.getElementById('pending-back-button'),
    pendingSummary: document.getElementById('pending-summary'),
    pendingList: document.getElementById('pending-list'),
    sendPendingButton: document.getElementById('send-pending-button'),
    storageUsage: document.getElementById('storage-usage'),
    storagePersistence: document.getElementById('storage-persistence'),
    storageOfflineApp: document.getElementById('storage-offline-app'),
    storageWarning: document.getElementById('storage-warning'),
    connectionStrips: document.querySelectorAll('[data-connection-strip]'),
    pendingBanners: document.querySelectorAll('[data-pending-banner]'),
    authBanners: document.querySelectorAll('[data-auth-banner]'),
    pairNowButtons: document.querySelectorAll('[data-pair-now]'),
    brands: document.querySelectorAll('[data-role-heading]'),
    pairingIntro: document.getElementById('pairing-intro'),
    manualEntryLabel: document.getElementById('manual-entry-label'),
    captureRole: document.getElementById('capture-role'),
    pendingTitle: document.getElementById('pending-title')
  };

  const Queue = window.DeliveryOfflineQueue;
  const Roles = window.PhotoRoles;

  const state = {
    role: null, // 'delivery' | 'bench' | 'ironmongery' - as last told by the PC (display only; the PC decides)
    reference: null, // photo-roles.js parseForRole() result: { role, code, baseOrder, delivery }
    sessionId: null, // one UUID per delivery capture session - also its tracking Event ID
    photos: [], // { id, blob, width, height, capturedAt, sha256, thumbUrl, status: 'pending'|'uploading'|'done'|'failed', error }
    scanController: null,
    camera: null,
    cameraOpening: null, // the openCamera() promise while the camera is still starting
    finishing: false, // Done is being handled right now (automatic sending waits)
    connection: { reachable: null, paired: null }, // the last Photo Service check
    pending: [], // the offline queue's sessions, as last read
    syncProgress: null, // { sessionId, sending, total } | { sessionId, completing } while sending
    persisted: null, // navigator.storage.persisted() - true/false, or null if unsupported
    lastScreen: null
  };

  let offlineStore = null; // null if this browser cannot store anything offline
  let syncEngine = null;

  function show(screen) {
    for (const el of [els.pairingScreen, els.scanScreen, els.captureScreen, els.resultScreen, els.pendingScreen]) el.hidden = el !== screen;
  }

  // ---- PAIRING screen -----------------------------------------------------
  // One-time-per-device: the iPad is paired once (a short code read off the
  // PC's own screen), then keeps a long-lived token in localStorage for
  // every future upload - see uploadOne() below. Never asks for the code
  // again unless the PC administrator deliberately resets pairing.

  const TOKEN_STORAGE_KEY = 'deliveryPhotosToken';
  // The role the PC last said this iPad is paired as, kept so the tool can
  // show the right screens (and keep working) away from the workshop. Only
  // ever written from the PC's own answer - and the PC never trusts it: every
  // upload is checked against the role stored with the pairing token on the PC.
  const ROLE_STORAGE_KEY = 'deliveryPhotosRole';

  function getStoredRole() {
    try {
      const role = localStorage.getItem(ROLE_STORAGE_KEY);
      if (Roles.isRole(role)) return role;
      // Paired before roles existed: Delivery was the only kind of iPad.
      return localStorage.getItem(TOKEN_STORAGE_KEY) ? 'delivery' : null;
    } catch {
      return null;
    }
  }

  function setRole(role) {
    if (!Roles.isRole(role)) return;
    try {
      localStorage.setItem(ROLE_STORAGE_KEY, role);
    } catch {
      // storage blocked - the role still applies for this visit
    }
    if (role !== state.role) {
      state.role = role;
      applyRole();
    }
  }

  function roleInfo(role = state.role) {
    return Roles.roleInfo(role);
  }

  // Makes the assigned role impossible to miss: every heading, the page
  // title, what the scan screen asks for, and the typed-entry field.
  function applyRole() {
    const info = roleInfo();
    const heading = info ? info.heading : 'WORKSHOP PHOTOS';
    for (const el of els.brands) el.textContent = heading;
    document.title = info ? `${info.label} Photos` : 'Workshop Photos';
    document.body.dataset.role = state.role || '';
    els.pairingSkipButton.hidden = !info; // a never-paired iPad has no role to take photos as yet
    els.pairingIntro.textContent = info
      ? `This iPad was paired as a ${info.label} iPad. Enter a new pairing code from the PC to pair it again.`
      : 'This iPad needs to be paired with the PC once before it can upload photos. The PC decides whether it is a Delivery, Bench or Ironmongery iPad.';
    if (!info) return;
    els.scanMessage.textContent = `${info.instruction}.`;
    els.manualEntryLabel.textContent = info.inputLabel;
    els.manualEntryInput.placeholder = info.placeholder;
    els.manualEntryButton.textContent = state.role === 'ironmongery' ? 'Type the order number' : 'Type the code instead';
    els.scanNextButton.textContent = { delivery: 'SCAN NEXT DELIVERY', bench: 'SCAN NEXT LABEL', ironmongery: 'NEXT ORDER' }[state.role];
    els.pendingTitle.textContent = state.role === 'delivery' ? 'Pending deliveries' : 'Pending photos';
    renderPending();
  }

  // "1 delivery" / "3 photo sessions" - Delivery iPads keep their wording.
  function sessionNoun(count) {
    if (state.role === 'bench' || state.role === 'ironmongery') return count === 1 ? 'photo session' : 'photo sessions';
    return count === 1 ? 'delivery' : 'deliveries';
  }

  function getStoredToken() {
    try {
      return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    } catch {
      return ''; // private browsing / storage blocked - treated as "not paired"
    }
  }

  function setStoredToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
      else localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // Nothing useful to do if storage is blocked - the next upload's 401
      // (if any) is what will actually surface the problem to the person.
    }
  }

  function showPairingScreen(message) {
    show(els.pairingScreen);
    els.pairingCodeInput.value = '';
    els.pairingError.hidden = !message;
    els.pairingError.textContent = message || '';
    els.pairingBusy.hidden = true;
  }

  els.pairingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = els.pairingCodeInput.value.trim();
    if (!code) {
      els.pairingError.hidden = false;
      els.pairingError.textContent = 'Enter the pairing code shown on the PC.';
      return;
    }

    els.pairingError.hidden = true;
    els.pairingBusy.hidden = false;
    try {
      const response = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.token) {
        showPairingScreen(data.message || 'Could not pair this device.');
        return;
      }
      setStoredToken(data.token);
      setRole(data.role);
      state.connection = { reachable: true, paired: true, role: data.role };
      renderConnection();
      startScanScreen();
      runSync(); // anything waiting on this iPad can go now
    } catch {
      showPairingScreen('Could not reach the Delivery Photos service on this PC.');
    } finally {
      els.pairingBusy.hidden = true;
    }
  });

  // Called once at startup, and again if an upload ever comes back 401 (the
  // PC administrator reset pairing, or this device was never paired at
  // all) - decides which screen to show without requiring a real photo
  // upload just to find out whether the stored token still works.
  async function checkPairingThenStart() {
    const token = getStoredToken();
    if (!token) {
      showPairingScreen();
      refreshConnection();
      return;
    }
    const service = await refreshConnection();
    if (!service.reachable || service.paired) {
      // Paired, or the PC cannot be reached at all right now (away from the
      // workshop) - either way the tool is usable: photographs taken while
      // the PC is out of reach are saved on this iPad and sent later, and a
      // real send attempt will still surface a revoked pairing then.
      startScanScreen();
    } else {
      showPairingScreen(state.pending.length > 0 ? `Pair this iPad again before pending ${sessionNoun(2)} can be sent.` : 'This iPad is no longer paired. Pair it again below.');
    }
  }

  els.pairingSkipButton.addEventListener('click', () => startScanScreen());
  for (const button of els.pairNowButtons) {
    button.addEventListener('click', () => showPairingScreen(`Pair this iPad again to send pending ${sessionNoun(2)}.`));
  }

  // ---- Photo Service connection -------------------------------------------
  // "Is the internet up?" (navigator.onLine) is NOT the question - the iPad
  // can have internet and still be nowhere near the workshop PC. What matters
  // is whether this PC's own Photo Service answers, so that is checked
  // directly, using the existing authenticated pairing check (which also
  // tells us whether this iPad is still paired). /api/ requests always go to
  // the real network - the Service Worker never answers them from a cache.

  const SERVICE_CHECK_TIMEOUT_MS = 5000;

  async function checkService() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SERVICE_CHECK_TIMEOUT_MS);
    const token = getStoredToken();
    try {
      const response = await fetch('/api/pair/check', { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store', signal: controller.signal });
      if (!response.ok) return { reachable: false, paired: false };
      const data = await response.json().catch(() => ({ paired: false }));
      const paired = Boolean(token && data.paired);
      return { reachable: true, paired, role: paired && Roles.isRole(data.role) ? data.role : null };
    } catch {
      return { reachable: false, paired: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshConnection() {
    const service = await checkService();
    if (service.reachable && !service.paired && getStoredToken()) setStoredToken(''); // revoked on the PC
    if (service.paired && service.role) setRole(service.role); // e.g. removed and re-paired as another role on the PC
    state.connection = service;
    renderConnection();
    return service;
  }

  function renderConnection() {
    const { reachable, paired } = state.connection;
    const internet = navigator.onLine ? 'Internet: available' : 'Internet: offline';
    let text;
    let cls = '';
    if (reachable === null) text = 'Checking the workshop Photo Service…';
    else if (reachable && paired) {
      text = 'Workshop Photo Service: connected';
      cls = 'conn-ok';
    } else if (reachable) {
      text = 'Workshop Photo Service: connected, but this iPad is not paired';
      cls = 'conn-offline';
    } else {
      text = `Workshop Photo Service: not reachable - photos will be saved on this iPad (${internet})`;
      cls = 'conn-offline';
    }
    for (const strip of els.connectionStrips) {
      strip.className = `connection-strip ${cls}`;
      strip.querySelector('[data-conn-text]').textContent = text;
    }
    renderAuthBanner();
  }

  // ---- SCAN screen ------------------------------------------------------

  async function startScanScreen() {
    if (!state.role) {
      showPairingScreen(); // nothing to take photos as until the PC has paired this iPad
      return;
    }
    show(els.scanScreen);
    applyRole();
    // Ironmongery's usual input is a typed order number - the box is ready.
    if (state.role === 'ironmongery') {
      els.manualEntryForm.hidden = false;
      els.manualEntryInput.value = '';
    }
    if (state.scanController) state.scanController.stop();

    if (!state.camera) {
      try {
        // Kept so beginCapture() can wait for it: a code typed in by hand
        // before the camera has finished opening (e.g. while iPadOS is still
        // asking for camera permission) must still get a live picture.
        state.cameraOpening = DeliveryPhotoCamera.openCamera(els.scanVideo);
        state.camera = await state.cameraOpening;
        els.cameraWarning.hidden = true;
      } catch (err) {
        els.cameraWarning.hidden = false;
        els.cameraWarning.textContent = `Could not open the camera (${err.message}). You can still type the ${state.role === 'ironmongery' ? 'order number' : 'code'} in by hand.`;
        return;
      } finally {
        state.cameraOpening = null;
      }
      if (els.scanScreen.hidden) return; // a code was typed in meanwhile - no scanning behind the capture screen
    } else {
      els.scanVideo.srcObject = state.camera.stream || els.scanVideo.srcObject;
    }

    state.scanController = DeliveryPhotoScanner.startScanning(els.scanVideo, els.scanCanvas, {
      onFound: (text) => onCodeScanned(text),
      onError: () => {} // a single failed decode attempt is routine, not worth surfacing
    });
  }

  function onCodeScanned(text) {
    const parsed = Roles.parseForRole(state.role, text);
    if (!parsed.ok) {
      els.scanMessage.textContent = `That is not a ${roleInfo().label} code (${parsed.reason}). Still scanning...`;
      // keep scanning - restart it, since startScanning() stops itself after any find attempt
      state.scanController = DeliveryPhotoScanner.startScanning(els.scanVideo, els.scanCanvas, { onFound: onCodeScanned, onError: () => {} });
      return;
    }
    beginCapture(parsed);
  }

  els.manualEntryButton.addEventListener('click', () => {
    els.manualEntryForm.hidden = false;
    els.manualEntryInput.value = '';
    els.manualEntryInput.focus();
  });
  els.manualEntryCancel.addEventListener('click', () => {
    els.manualEntryForm.hidden = true;
  });
  // A refused code marks the field invalid; the browser then blocks every
  // later submit until that mark is cleared - so clear it as soon as the
  // person edits what they typed.
  els.manualEntryInput.addEventListener('input', () => els.manualEntryInput.setCustomValidity(''));

  els.manualEntryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = Roles.parseForRole(state.role, els.manualEntryInput.value);
    if (!parsed.ok) {
      els.manualEntryInput.setCustomValidity(parsed.reason);
      els.manualEntryInput.reportValidity();
      return;
    }
    els.manualEntryInput.setCustomValidity('');
    els.manualEntryForm.hidden = true;
    if (state.scanController) state.scanController.stop();
    beginCapture(parsed);
  });

  // ---- CAPTURE screen -----------------------------------------------------

  async function beginCapture(parsed) {
    if (state.scanController) state.scanController.stop();
    state.reference = parsed;
    state.sessionId = crypto.randomUUID();
    state.photos = [];
    renderThumbnails();
    const info = roleInfo(parsed.role);
    els.captureRole.textContent = info.heading;
    // What was scanned, and the order folder the photos will be filed under.
    if (parsed.role === 'ironmongery') {
      els.referenceLabel.textContent = `Order: ${parsed.baseOrder}`;
      els.referenceSub.textContent = `Photos will save under order ${parsed.baseOrder}`;
    } else if (parsed.role === 'bench') {
      els.referenceLabel.textContent = `Scanned: ${parsed.code}`;
      els.referenceSub.textContent = `Order: ${parsed.baseOrder} · Photos will save under order ${parsed.baseOrder}`;
    } else {
      els.referenceLabel.textContent = `Delivery: ${parsed.code}`;
      els.referenceSub.textContent = `Order: ${parsed.baseOrder}${parsed.delivery.type === 'part' ? ` · Part delivery ${parsed.delivery.partNumber}` : ' · Full delivery'}`;
    }
    show(els.captureScreen);
    if (!els.scanVideo.srcObject && state.cameraOpening) await state.cameraOpening.catch(() => {});
    els.captureVideo.srcObject = els.scanVideo.srcObject; // same already-open stream, no reopen
    els.captureVideo.play().catch(() => {});
  }

  function revokeThumb(photo) {
    if (photo.thumbUrl) URL.revokeObjectURL(photo.thumbUrl);
  }

  function renderThumbnails() {
    els.thumbnails.innerHTML = '';
    for (const photo of state.photos) {
      const fig = document.createElement('figure');
      fig.className = `thumb thumb-${photo.status}`;
      const img = document.createElement('img');
      img.src = photo.thumbUrl;
      img.alt = 'Captured photograph';
      fig.appendChild(img);

      if (photo.status !== 'uploading') {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'thumb-delete';
        del.setAttribute('aria-label', 'Delete this photograph');
        del.textContent = '×';
        del.addEventListener('click', () => deletePhoto(photo.id));
        fig.appendChild(del);
      }
      if (photo.status === 'failed') {
        const badge = document.createElement('span');
        badge.className = 'thumb-badge';
        badge.textContent = 'Failed';
        fig.appendChild(badge);
      }
      els.thumbnails.appendChild(fig);
    }
    const count = state.photos.length;
    els.photoCount.textContent = count === 1 ? '1 photograph' : `${count} photographs`;
    els.doneButton.disabled = count === 0; // never allow submitting zero photographs
  }

  function deletePhoto(id) {
    const index = state.photos.findIndex((p) => p.id === id);
    if (index === -1) return;
    revokeThumb(state.photos[index]);
    state.photos.splice(index, 1);
    renderThumbnails();
  }

  async function takePhoto() {
    els.shutterButton.disabled = true;
    try {
      const { blob, width, height } = await DeliveryPhotoCamera.capturePhoto(els.captureVideo, els.captureCanvas);
      state.photos.push({ id: crypto.randomUUID(), blob, width, height, capturedAt: new Date().toISOString(), sha256: '', thumbUrl: URL.createObjectURL(blob), status: 'pending', error: '' });
      renderThumbnails();
    } catch (err) {
      els.cameraWarning.hidden = false;
      els.cameraWarning.textContent = `Could not take that photograph (${err.message}). Please try again.`;
    } finally {
      els.shutterButton.disabled = false;
    }
  }
  els.shutterButton.addEventListener('click', takePhoto);

  // Fallback for when live capture is unavailable or was declined - a normal
  // camera-app photo picked from the native UI, added the same way a live
  // shutter press would be.
  els.fallbackInput.addEventListener('change', async () => {
    for (const file of els.fallbackInput.files) {
      const dims = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ width: 0, height: 0 });
        img.src = URL.createObjectURL(file);
      });
      state.photos.push({ id: crypto.randomUUID(), blob: file, width: dims.width, height: dims.height, capturedAt: new Date().toISOString(), sha256: '', thumbUrl: URL.createObjectURL(file), status: 'pending', error: '' });
    }
    els.fallbackInput.value = '';
    renderThumbnails();
  });

  els.abandonButton.addEventListener('click', () => {
    if (state.photos.some((p) => p.status !== 'done')) {
      if (!confirm('Discard the photographs taken here and scan a different code?')) return;
    }
    for (const photo of state.photos) revokeThumb(photo);
    state.photos = [];
    startScanScreen();
  });

  // ---- Uploading ----------------------------------------------------------

  async function sha256Hex(blob) {
    return Queue.sha256Hex(await blob.arrayBuffer());
  }

  // One photograph to the Photo Service. `body` is a Blob. The server files
  // it, reads it back off the drive and only answers 201 once it matches -
  // and if the same bytes are sent again (a retry after a lost answer) it
  // recognises the file already on the drive rather than filing it twice.
  // `code` is the scanned value; the PC works out the order folder and the
  // file name itself, from the role it holds for this iPad's token. `role`
  // is only the role the photo was taken as (see offline-queue.js).
  // Resolves { ok } or { ok: false, error, needsPairing?, wrongRole?, unreachable? }.
  function uploadBytes({ role, code, photoId, body, sha256 }) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/photos/${encodeURIComponent(code)}/${photoId}`);
      xhr.setRequestHeader('Content-Type', 'image/jpeg');
      xhr.setRequestHeader('Authorization', `Bearer ${getStoredToken()}`);
      xhr.setRequestHeader('X-Photo-Sha256', sha256);
      xhr.setRequestHeader('X-Photo-Role', role);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ ok: true });
          return;
        }
        let message = `The server answered ${xhr.status}.`;
        try {
          message = JSON.parse(xhr.responseText).message || message;
        } catch {
          // non-JSON error body - keep the generic message
        }
        // retryable (429/5xx) is distinct from "this device needs to pair
        // again" (401) - the caller uses needsPairing to decide whether to
        // send the person back to the pairing screen instead of just
        // showing a normal per-photo failure.
        resolve({ ok: false, error: message, needsPairing: xhr.status === 401, wrongRole: xhr.status === 403 });
      };
      xhr.onerror = () => resolve({ ok: false, error: 'Could not reach the Delivery Photos service on this PC.', unreachable: true });
      xhr.ontimeout = () => resolve({ ok: false, error: 'The upload timed out.', unreachable: true });
      xhr.timeout = 60000;
      xhr.send(body);
    });
  }

  async function uploadOne(photo, parsed) {
    if (!photo.sha256) photo.sha256 = await sha256Hex(photo.blob);
    return uploadBytes({ role: parsed.role, code: parsed.code, photoId: photo.id, body: photo.blob, sha256: photo.sha256 });
  }

  // Uploads every not-yet-done photograph IN ORDER (never in parallel - this
  // is what lets "Saving N of M" mean something concrete), updating the
  // saving overlay as it goes. Returns { savedCount, failedCount, needsPairing, wrongRole }.
  async function uploadPending() {
    const toSend = state.photos.filter((p) => p.status !== 'done');
    els.savingOverlay.hidden = false;
    let done = state.photos.length - toSend.length;
    const total = state.photos.length;
    let needsPairing = false;
    let wrongRole = false;

    for (const photo of toSend) {
      photo.status = 'uploading';
      renderThumbnails();
      els.savingProgress.textContent = `Saving ${done + 1} of ${total}...`;

      const result = await uploadOne(photo, state.reference);
      if (result.ok) {
        photo.status = 'done';
        photo.error = '';
        done++;
      } else {
        photo.status = 'failed';
        photo.error = result.error;
        if (result.needsPairing) needsPairing = true;
        if (result.wrongRole) wrongRole = true;
      }
      renderThumbnails();
    }

    els.savingOverlay.hidden = true;
    return { savedCount: state.photos.filter((p) => p.status === 'done').length, failedCount: state.photos.filter((p) => p.status === 'failed').length, needsPairing, wrongRole };
  }

  // Tells the Windows app that this whole session's photographs are
  // confirmed saved (for a Delivery, it then records the Google Sheets
  // tracking event; Bench and Ironmongery are not tracked) - only
  // ever called after EVERY photo in the session already came back 201 from
  // PUT /api/photos/... (checksum-verified, read back off the drive). The
  // session id becomes the tracking Event ID, so a repeat of the same report
  // never creates a second event. Resolves { ok } or { ok: false, error,
  // needsPairing?, wrongRole?, unreachable? }.
  async function completeSession({ sessionId, role, code, photosSaved }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/photo-sessions/complete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${getStoredToken()}`, 'Content-Type': 'application/json', 'X-Photo-Role': role },
        body: JSON.stringify({ sessionId, code, photosSaved }),
        cache: 'no-store',
        signal: controller.signal
      });
      if (response.ok) return { ok: true };
      const data = await response.json().catch(() => ({}));
      return { ok: false, error: data.message || `The server answered ${response.status}.`, needsPairing: response.status === 401, wrongRole: response.status === 403 };
    } catch {
      return { ok: false, error: 'Could not reach the Delivery Photos service on this PC.', unreachable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  function showResult({ icon, iconClass, heading, detail, warning = '', retryLabel = '' }) {
    els.resultIcon.textContent = icon;
    els.resultIcon.className = `result-icon ${iconClass}`;
    els.resultHeading.textContent = heading;
    els.resultReference.textContent = state.reference ? (state.reference.role === 'delivery' ? state.reference.code : `Order ${state.reference.baseOrder}`) : '';
    els.resultDetail.textContent = detail;
    els.resultWarning.hidden = !warning;
    els.resultWarning.textContent = warning;
    els.retryButton.hidden = !retryLabel;
    els.retryButton.textContent = retryLabel;
    show(els.resultScreen);
  }

  function clearCurrentPhotos() {
    for (const photo of state.photos) revokeThumb(photo);
    state.photos = [];
  }

  let retryAction = null;

  // Done: send straight to the Photo Service if it answers; otherwise (or
  // for whatever part of the session could not be sent) save it on this iPad.
  async function finishSession() {
    if (state.finishing) return;
    state.finishing = true;
    try {
      els.savingOverlay.hidden = false;
      els.savingProgress.textContent = 'Checking the connection to the workshop PC...';
      const service = await refreshConnection();
      els.savingOverlay.hidden = true;
      if (!service.reachable) return await saveSessionOnIpad('unreachable');
      if (!service.paired) return await saveSessionOnIpad('unpaired');

      const { failedCount, needsPairing, wrongRole } = await uploadPending();
      const total = state.photos.length;

      // This device's token was rejected (pairing was reset) - the photos
      // not yet sent are kept on this iPad, never thrown away.
      if (needsPairing) {
        setStoredToken('');
        state.connection = { reachable: true, paired: false };
        renderConnection();
        return await saveSessionOnIpad('unpaired');
      }
      // Re-paired as another role on the PC since this capture began: keep
      // the photos, safely, rather than drop them.
      if (wrongRole) {
        await refreshConnection();
        return await saveSessionOnIpad('wrong_role');
      }
      if (failedCount > 0) return await saveSessionOnIpad('partial');

      // Every photograph is verified on the drive. Report the session; if
      // that report does not get through, it is queued on this iPad (with no
      // photo data - nothing left to upload) and retried automatically.
      const done = await completeSession({ sessionId: state.sessionId, role: state.reference.role, code: state.reference.code, photosSaved: total });
      if (!done.ok) {
        try {
          await queueCurrentSession();
        } catch (err) {
          // The photographs themselves are already safely filed - only the
          // tracking report is lost, exactly as before offline support.
          console.warn('Could not queue the session-complete report for a later retry:', err);
        }
      }
      showResult({
        icon: '✓',
        iconClass: 'result-ok',
        heading: 'Photographs filed successfully',
        detail: `${total === 1 ? '1 photograph' : `${total} photographs`} saved and verified on the company drive. Safe to continue.`
      });
      clearCurrentPhotos();
      refreshPending();
    } finally {
      els.savingOverlay.hidden = true;
      state.finishing = false;
    }
  }

  // Writes the current session to the offline queue (photos already on the
  // drive are recorded as such, without their bytes). Throws if it could not
  // be saved AND verified - the caller must then keep the photos in memory.
  async function queueCurrentSession() {
    if (!offlineStore) throw new Error('This browser cannot store photographs offline (its storage is unavailable - is this a Private Browsing tab?).');
    const photos = [];
    let neededBytes = 0;
    for (const photo of state.photos) {
      const uploaded = photo.status === 'done';
      const bytes = uploaded ? null : await photo.blob.arrayBuffer();
      if (bytes) neededBytes += bytes.byteLength;
      photos.push({ photoId: photo.id, bytes, sha256: photo.sha256 || '', sizeBytes: photo.blob.size, width: photo.width, height: photo.height, capturedAt: photo.capturedAt, uploaded });
    }
    const estimate = await estimateStorage();
    const space = Queue.assessStorage(estimate, neededBytes);
    if (!space.canStore) throw new Error(`${space.reason} (${Queue.formatBytes(neededBytes)} needed, ${Queue.formatBytes(space.availableBytes)} available.)`);

    const meta = Queue.sessionMetadata(state.reference);
    await offlineStore.saveSession({ sessionId: state.sessionId, ...meta, capturedAt: state.photos[0] && state.photos[0].capturedAt }, photos);
    requestPersistence();
  }

  async function saveSessionOnIpad(reason) {
    const total = state.photos.length;
    const sentCount = state.photos.filter((p) => p.status === 'done').length;
    els.savingOverlay.hidden = false;
    els.savingProgress.textContent = 'Saving on this iPad...';
    try {
      await queueCurrentSession();
    } catch (err) {
      els.savingOverlay.hidden = true;
      retryAction = () => finishSession();
      showResult({
        icon: '!',
        iconClass: 'result-partial',
        heading: 'Could not save these photographs',
        detail: `${err.message} The photographs are still open here - do not leave this screen. Connect to the workshop Wi-Fi and press TRY AGAIN.`,
        retryLabel: 'TRY AGAIN'
      });
      return;
    }
    els.savingOverlay.hidden = true;
    clearCurrentPhotos();
    await refreshPending();

    const persistWarning = state.persisted === false ? 'Offline storage is available, but iPad may remove it if storage space becomes low. Send these as soon as you are back on the workshop Wi-Fi.' : '';
    if (reason === 'partial') {
      retryAction = () => openPendingScreen(true);
      showResult({
        icon: '!',
        iconClass: 'result-partial',
        heading: `${sentCount} of ${total} sent to the company drive`,
        detail: `The other ${total - sentCount} ${total - sentCount === 1 ? 'is' : 'are'} saved on this iPad and will be sent automatically. Photos remain safely stored on this iPad.`,
        warning: persistWarning,
        retryLabel: 'SEND NOW'
      });
    } else {
      retryAction = null;
      showResult({
        icon: '✓',
        iconClass: 'result-ok',
        heading: 'Saved on this iPad',
        detail:
          reason === 'unpaired'
            ? `Waiting to send to company drive. Pair this iPad again to send pending ${sessionNoun(2)}.`
            : reason === 'wrong_role'
              ? 'This iPad has been paired for a different kind of photo on the PC since these were taken, so they were not sent. They are kept on this iPad - see Pending.'
              : 'Waiting to send to company drive. It will be sent automatically when this iPad is back on the workshop Wi-Fi with this tool open.',
        warning: persistWarning
      });
    }
  }

  els.doneButton.addEventListener('click', () => {
    if (state.photos.length === 0) return; // belt and braces - the button is disabled at zero already
    finishSession();
  });

  els.retryButton.addEventListener('click', () => {
    if (retryAction) retryAction();
  });

  els.scanNextButton.addEventListener('click', () => {
    // Only possible if saving on this iPad itself failed - never lose those silently.
    if (state.photos.some((p) => p.status !== 'done')) {
      if (!confirm('These photographs have NOT been saved anywhere yet. Discard them?')) return;
    }
    clearCurrentPhotos();
    state.reference = null;
    startScanScreen();
  });

  // ---- Offline queue: pending deliveries ------------------------------------

  async function estimateStorage() {
    try {
      if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
    } catch {
      // unsupported or refused - reported as "unknown"
    }
    return null;
  }

  // Asks the browser to keep this site's storage even when the iPad runs low
  // on space. Never blocks anything if refused - the person is told instead.
  async function requestPersistence() {
    try {
      if (!navigator.storage || !navigator.storage.persist) {
        state.persisted = null;
        return;
      }
      state.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    } catch {
      state.persisted = false;
    }
    renderStorage();
  }

  async function renderStorage() {
    const space = Queue.assessStorage(await estimateStorage());
    els.storageUsage.textContent = space.known
      ? `${Queue.formatBytes(space.usedBytes)} used · ${Queue.formatBytes(space.availableBytes)} available`
      : 'This browser does not report how much storage space is left.';

    if (state.persisted === true) els.storagePersistence.textContent = 'Protected from automatic clearing: yes.';
    else if (state.persisted === false) els.storagePersistence.textContent = 'Protected from automatic clearing: no - offline storage is available, but iPad may remove it if storage space becomes low.';
    else els.storagePersistence.textContent = 'Protected from automatic clearing: not supported by this browser.';

    const standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    const offlineReady = Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);
    els.storageOfflineApp.textContent =
      (offlineReady ? 'Opens without the workshop PC: yes.' : 'Opens without the workshop PC: not yet - open this tool once on the workshop Wi-Fi first.') +
      (standalone ? '' : ' Tip: add this tool to the Home Screen (Share → Add to Home Screen) - iPadOS keeps a Home Screen app\'s storage more reliably.');

    const warnings = [];
    if (space.high) warnings.push(`Offline storage is nearly full (${Math.round(space.fraction * 100)}% used). Send pending deliveries as soon as possible.`);
    if (state.persisted === false && state.pending.length > 0) warnings.push('Offline storage is available, but iPad may remove it if storage space becomes low.');
    els.storageWarning.hidden = warnings.length === 0;
    els.storageWarning.textContent = warnings.join(' ');
  }

  const capturedFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function sessionStatusText(session) {
    const progress = state.syncProgress;
    if (progress && progress.sessionId === session.sessionId) {
      return { text: progress.completing ? 'Confirming with the workshop PC...' : `Sending ${progress.sending} of ${progress.total}...`, sending: true };
    }
    if (session.status === Queue.STATUS.NEEDS_PAIRING) return { text: `Pair this iPad again to send pending ${sessionNoun(2)}` };
    if (session.status === Queue.STATUS.WRONG_ROLE || (state.role && Queue.sessionRole(session) !== state.role)) {
      const taken = roleInfo(Queue.sessionRole(session));
      return { text: `Taken as ${taken ? taken.label : 'other'} photos - this iPad is now paired for ${roleInfo() ? roleInfo().label : 'something else'}. Pair it as ${taken ? taken.label : 'that role'} again to send, or discard.`, wrongRole: true };
    }
    if (session.status === Queue.STATUS.FAILED) return { text: 'Could not send - photos remain safely stored on this iPad', error: session.lastError };
    if (state.connection.reachable === false) return { text: 'Waiting for workshop network' };
    return { text: 'Waiting to send' };
  }

  function renderPending() {
    const sessions = state.pending;
    const count = sessions.length;
    const progress = state.syncProgress;

    for (const banner of els.pendingBanners) {
      banner.hidden = count === 0;
      banner.textContent = progress
        ? `${count} ${sessionNoun(count)} waiting - sending ${progress.reference || ''}...`
        : `${count} ${sessionNoun(count)} waiting to send ›`;
    }

    els.pendingSummary.textContent =
      count === 0 ? `Nothing waiting - every ${sessionNoun(1)} has been sent.` : `${count} ${sessionNoun(count)} waiting to send`;
    els.sendPendingButton.disabled = count === 0 || Boolean(progress);

    els.pendingList.innerHTML = '';
    for (const session of sessions) {
      const li = document.createElement('li');
      li.className = 'pending-item';
      const status = sessionStatusText(session);

      // e.g. "Bench" / "5698", "Ironmongery" / "5626-2", "Delivery" / "5698-P2-DELIV".
      const role = Queue.sessionRole(session);
      const roleEl = document.createElement('div');
      roleEl.className = `pending-item-role role-${role}`;
      roleEl.textContent = roleInfo(role) ? roleInfo(role).label : role;
      const ref = document.createElement('div');
      ref.className = 'pending-item-ref';
      ref.textContent = role === 'delivery' ? Queue.sessionCode(session) : session.baseOrder || session.orderNumber;
      const meta = document.createElement('div');
      meta.className = 'pending-item-meta';
      meta.textContent = `${role === 'bench' ? `Scanned ${Queue.sessionCode(session)} · ` : ''}${session.photoCount} ${session.photoCount === 1 ? 'photo' : 'photos'} · Captured ${capturedFormat.format(new Date(session.capturedAt))}`;
      const statusEl = document.createElement('div');
      statusEl.className = `pending-item-status${status.sending ? ' status-sending' : ''}`;
      statusEl.textContent = status.text;
      li.append(roleEl, ref, meta, statusEl);
      if (status.error) {
        const err = document.createElement('div');
        err.className = 'pending-item-error';
        err.textContent = `Last error: ${status.error}`;
        li.appendChild(err);
      }

      if (!status.sending) {
        const actions = document.createElement('div');
        actions.className = 'pending-item-actions';
        if (session.status === Queue.STATUS.NEEDS_PAIRING) {
          const pair = document.createElement('button');
          pair.type = 'button';
          pair.className = 'secondary-button';
          pair.textContent = 'Pair now';
          pair.addEventListener('click', () => showPairingScreen(`Pair this iPad again to send pending ${sessionNoun(2)}.`));
          actions.appendChild(pair);
        } else if (status.wrongRole) {
          // Nothing to retry until the PC pairs this iPad as that role again.
        } else {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'secondary-button';
          retry.textContent = 'Retry';
          retry.disabled = Boolean(progress);
          retry.addEventListener('click', () => runSync({ onlySessionId: session.sessionId }));
          actions.appendChild(retry);
        }
        const discard = document.createElement('button');
        discard.type = 'button';
        discard.className = 'link-button link-button-danger';
        discard.textContent = 'Discard';
        discard.addEventListener('click', () => discardSession(session));
        actions.appendChild(discard);
        li.appendChild(actions);
      }
      els.pendingList.appendChild(li);
    }
    renderAuthBanner();
  }

  function renderAuthBanner() {
    const needsPairing =
      state.pending.some((s) => s.status === Queue.STATUS.NEEDS_PAIRING) || (state.pending.length > 0 && state.connection.reachable === true && !state.connection.paired);
    for (const banner of els.authBanners) banner.hidden = !needsPairing;
  }

  async function refreshPending() {
    if (offlineStore) {
      try {
        state.pending = await offlineStore.listSessions();
      } catch {
        // keep showing the last known list rather than an empty one
      }
    }
    renderPending();
    renderStorage();
  }

  async function discardSession(session) {
    const label = Queue.sessionRole(session) === 'delivery' ? Queue.sessionCode(session) : `${roleInfo(Queue.sessionRole(session)).label} photos for order ${session.baseOrder || session.orderNumber}`;
    if (!confirm(`Permanently delete ${label} (${session.photoCount} ${session.photoCount === 1 ? 'photo' : 'photos'}) from this iPad? Any photos not yet sent to the company drive will be lost.`)) return;
    await offlineStore.deleteSession(session.sessionId);
    await refreshPending();
  }

  // Sends what is waiting. Shared by every trigger - automatic and manual.
  async function runSync(options) {
    if (!syncEngine) return null;
    const result = await syncEngine.syncAll(options);
    if (result.outcome === 'unreachable') state.connection = { reachable: false, paired: state.connection.paired };
    if (result.outcome === 'needs_pairing') {
      setStoredToken('');
      state.connection = { reachable: true, paired: false };
    }
    if (result.outcome === 'done') state.connection = { ...state.connection, reachable: true, paired: true };
    renderConnection();
    await refreshPending();
    return result;
  }

  // Automatic, foreground-only sending (see offline-queue.js's
  // installAutoSync for exactly when this runs). Skipped while Done is being
  // handled, so the person's current delivery always goes first.
  async function autoSync() {
    if (state.finishing) return;
    const service = await refreshConnection();
    await refreshPending();
    if (service.reachable && service.paired && state.pending.length > 0 && !state.finishing) runSync();
  }

  function openPendingScreen(sendNow) {
    state.lastScreen = [els.pairingScreen, els.scanScreen, els.captureScreen, els.resultScreen].find((el) => !el.hidden) || els.scanScreen;
    show(els.pendingScreen);
    refreshPending();
    if (sendNow) runSync();
  }

  for (const banner of els.pendingBanners) banner.addEventListener('click', () => openPendingScreen(false));
  els.sendPendingButton.addEventListener('click', () => runSync());
  els.pendingBackButton.addEventListener('click', () => {
    if (state.lastScreen === els.resultScreen || state.lastScreen === els.scanScreen || !state.lastScreen) startScanScreen();
    else show(state.lastScreen);
  });

  // ---- Start ---------------------------------------------------------------

  // The Service Worker keeps a copy of this tool on the iPad so it opens with
  // no connection to the PC (see sw.js). Registering it is harmless to repeat.
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => console.warn('Offline app shell not available:', err));
    navigator.serviceWorker.addEventListener('controllerchange', () => renderStorage());
  }

  async function start() {
    state.role = getStoredRole();
    applyRole();
    registerServiceWorker();
    requestPersistence();
    try {
      offlineStore = await Queue.openStore({ indexedDB: window.indexedDB });
      syncEngine = Queue.createSyncEngine({
        store: offlineStore,
        api: {
          checkService,
          uploadPhoto: ({ role, code, photoId, bytes, sha256 }) => uploadBytes({ role, code, photoId, body: new Blob([bytes], { type: 'image/jpeg' }), sha256 }),
          completeSession
        },
        onProgress: (progress) => {
          state.syncProgress = progress;
          renderPending();
        },
        // Only one tab at a time may send, so two open copies of this tool
        // can never upload the same queued session side by side.
        withLock: navigator.locks ? (fn) => navigator.locks.request('delivery-photos-sync', { ifAvailable: true }, (lock) => (lock ? fn() : null)) : undefined
      });
    } catch (err) {
      console.warn('Offline storage is not available in this browser:', err);
    }
    await refreshPending();
    await checkPairingThenStart();
    Queue.installAutoSync({ win: window, doc: document, run: () => autoSync() });
  }

  start();
})();

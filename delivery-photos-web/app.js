// The Delivery Photos iPad tool. Three screens, one page, no framework:
//   SCAN     - live camera, looking for a Data Matrix code
//   CAPTURE  - the recognised delivery, live camera, thumbnails, Done
//   RESULT   - saved (all photographs verified on the drive) or partial
//              (some failed - retry those specific ones)
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
    cameraWarning: document.getElementById('camera-warning')
  };

  const state = {
    reference: null, // { reference, orderNumber, type, partNumber }
    photos: [], // { id, blob, width, height, thumbUrl, status: 'pending'|'uploading'|'done'|'failed', error }
    scanController: null,
    camera: null
  };

  function show(screen) {
    for (const el of [els.pairingScreen, els.scanScreen, els.captureScreen, els.resultScreen]) el.hidden = el !== screen;
  }

  // ---- PAIRING screen -----------------------------------------------------
  // One-time-per-device: the iPad is paired once (a short code read off the
  // PC's own screen), then keeps a long-lived token in localStorage for
  // every future upload - see uploadOne() below. Never asks for the code
  // again unless the PC administrator deliberately resets pairing.

  const TOKEN_STORAGE_KEY = 'deliveryPhotosToken';

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
      startScanScreen();
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
      return;
    }
    try {
      const response = await fetch('/api/pair/check', { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json().catch(() => ({ paired: false }));
      if (data.paired) {
        startScanScreen();
      } else {
        setStoredToken('');
        showPairingScreen('This iPad is no longer paired. Pair it again below.');
      }
    } catch {
      // Could not even reach the server to check - rather than block the
      // whole app on a transient network hiccup, proceed as if paired; a
      // real upload attempt will surface the same 401 if it is truly revoked.
      startScanScreen();
    }
  }

  // ---- SCAN screen ------------------------------------------------------

  async function startScanScreen() {
    show(els.scanScreen);
    els.scanMessage.textContent = 'Point the camera at the delivery note code.';
    if (state.scanController) state.scanController.stop();

    if (!state.camera) {
      try {
        state.camera = await DeliveryPhotoCamera.openCamera(els.scanVideo);
        els.cameraWarning.hidden = true;
      } catch (err) {
        els.cameraWarning.hidden = false;
        els.cameraWarning.textContent = `Could not open the camera (${err.message}). You can still enter the code by hand.`;
        return;
      }
    } else {
      els.scanVideo.srcObject = state.camera.stream || els.scanVideo.srcObject;
    }

    state.scanController = DeliveryPhotoScanner.startScanning(els.scanVideo, els.scanCanvas, {
      onFound: (text) => onCodeScanned(text),
      onError: () => {} // a single failed decode attempt is routine, not worth surfacing
    });
  }

  function onCodeScanned(text) {
    const parsed = DeliveryReference.parse(text);
    if (!parsed.ok) {
      els.scanMessage.textContent = `That does not look like a delivery code (${parsed.reason}). Still scanning...`;
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
  els.manualEntryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = DeliveryReference.parse(els.manualEntryInput.value);
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

  function beginCapture(parsed) {
    if (state.scanController) state.scanController.stop();
    state.reference = parsed;
    state.photos = [];
    renderThumbnails();
    els.referenceLabel.textContent = state.reference.reference;
    els.referenceSub.textContent = DeliveryReference.describe(state.reference);
    els.captureVideo.srcObject = els.scanVideo.srcObject; // same already-open stream, no reopen
    show(els.captureScreen);
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
      state.photos.push({ id: crypto.randomUUID(), blob, width, height, thumbUrl: URL.createObjectURL(blob), status: 'pending', error: '' });
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
      state.photos.push({ id: crypto.randomUUID(), blob: file, width: dims.width, height: dims.height, thumbUrl: URL.createObjectURL(file), status: 'pending', error: '' });
    }
    els.fallbackInput.value = '';
    renderThumbnails();
  });

  els.abandonButton.addEventListener('click', () => {
    if (state.photos.some((p) => p.status !== 'done')) {
      if (!confirm('Discard the photographs taken for this delivery and scan a different code?')) return;
    }
    for (const photo of state.photos) revokeThumb(photo);
    state.photos = [];
    startScanScreen();
  });

  // ---- Uploading ----------------------------------------------------------

  async function sha256Hex(blob) {
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function uploadOne(photo, reference) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/photos/${encodeURIComponent(reference)}/${photo.id}`);
      xhr.setRequestHeader('Content-Type', 'image/jpeg');
      xhr.setRequestHeader('Authorization', `Bearer ${getStoredToken()}`);
      sha256Hex(photo.blob).then((hash) => {
        xhr.setRequestHeader('X-Photo-Sha256', hash);
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
          resolve({ ok: false, error: message, needsPairing: xhr.status === 401 });
        };
        xhr.onerror = () => resolve({ ok: false, error: 'Could not reach the Delivery Photos service on this PC.' });
        xhr.ontimeout = () => resolve({ ok: false, error: 'The upload timed out.' });
        xhr.timeout = 60000;
        xhr.send(photo.blob);
      });
    });
  }

  // Uploads every not-yet-done photograph IN ORDER (never in parallel - this
  // is what lets "Saving N of M" mean something concrete), updating the
  // saving overlay as it goes. Returns { savedCount, failedCount, needsPairing }.
  async function uploadPending() {
    const toSend = state.photos.filter((p) => p.status !== 'done');
    els.savingOverlay.hidden = false;
    let done = state.photos.length - toSend.length;
    const total = state.photos.length;
    let needsPairing = false;

    for (const photo of toSend) {
      photo.status = 'uploading';
      renderThumbnails();
      els.savingProgress.textContent = `Saving ${done + 1} of ${total}...`;

      const result = await uploadOne(photo, state.reference.reference);
      if (result.ok) {
        photo.status = 'done';
        photo.error = '';
        done++;
      } else {
        photo.status = 'failed';
        photo.error = result.error;
        if (result.needsPairing) needsPairing = true;
      }
      renderThumbnails();
    }

    els.savingOverlay.hidden = true;
    return { savedCount: state.photos.filter((p) => p.status === 'done').length, failedCount: state.photos.filter((p) => p.status === 'failed').length, needsPairing };
  }

  // Tells the Windows app that this whole delivery's photographs are
  // confirmed saved, so it can record a Google Sheets tracking event - only
  // ever called after EVERY photo in the session already came back 201 from
  // PUT /api/photos/... (checksum-verified, read back off the drive). Fire
  // and forget, deliberately: whether this succeeds, fails, or the internet
  // to Google Sheets is down for days makes no difference to the photos
  // already safely on the drive, so it must never affect what is shown
  // here - only a console note for anyone debugging on the iPad itself.
  function reportSessionComplete(reference, photosSaved) {
    fetch(`/api/delivery-sessions/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getStoredToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference, photosSaved })
    }).catch((err) => {
      console.warn('Could not report this delivery as complete for tracking (photographs are still safely saved):', err);
    });
  }

  async function runUploadAndShowResult() {
    const { savedCount, failedCount, needsPairing } = await uploadPending();
    const total = state.photos.length;

    // This device's token was rejected (pairing was reset, or never paired
    // at all somehow) - sent back to pair again rather than left stuck
    // showing "failed" on every retry forever with no way out.
    if (needsPairing) {
      setStoredToken('');
      showPairingScreen('This iPad is no longer paired - the photographs already saved are safe, but the rest need pairing again first.');
      return;
    }

    if (failedCount === 0) {
      if (total > 0) reportSessionComplete(state.reference.reference, savedCount);
      els.resultIcon.textContent = '✓';
      els.resultIcon.className = 'result-icon result-ok';
      els.resultHeading.textContent = total === 1 ? '1 photograph saved' : `${total} photographs saved`;
      els.resultReference.textContent = state.reference.reference;
      els.resultDetail.textContent = 'Safe to continue.';
      els.retryButton.hidden = true;
    } else {
      els.resultIcon.textContent = '!';
      els.resultIcon.className = 'result-icon result-partial';
      els.resultHeading.textContent = `${savedCount} of ${total} saved`;
      els.resultReference.textContent = state.reference.reference;
      els.resultDetail.textContent = failedCount === 1 ? '1 photograph failed to save.' : `${failedCount} photographs failed to save.`;
      els.retryButton.hidden = false;
    }
    show(els.resultScreen);
  }

  els.doneButton.addEventListener('click', () => {
    if (state.photos.length === 0) return; // belt and braces - the button is disabled at zero already
    runUploadAndShowResult();
  });

  els.retryButton.addEventListener('click', async () => {
    show(els.captureScreen); // show progress against the real thumbnails while retrying
    await runUploadAndShowResult();
  });

  els.scanNextButton.addEventListener('click', () => {
    for (const photo of state.photos) revokeThumb(photo);
    state.photos = [];
    state.reference = null;
    startScanScreen();
  });

  // ---- Start ---------------------------------------------------------------

  checkPairingThenStart();
})();

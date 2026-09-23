// The Delivery Photos iPad tool. Three screens, one page, no framework:
//   SCAN     - live camera, looking for a Data Matrix code
//   CAPTURE  - the recognised delivery, live camera, thumbnails, Done
//   RESULT   - saved (all photographs verified on the drive) or partial
//              (some failed - retry those specific ones)
'use strict';

(() => {
  const els = {
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
    for (const el of [els.scanScreen, els.captureScreen, els.resultScreen]) el.hidden = el !== screen;
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
      sha256Hex(photo.blob).then((hash) => {
        xhr.setRequestHeader('X-Photo-Sha256', hash);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true });
          else {
            let message = `The server answered ${xhr.status}.`;
            try {
              message = JSON.parse(xhr.responseText).message || message;
            } catch {
              // non-JSON error body - keep the generic message
            }
            resolve({ ok: false, error: message });
          }
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
  // saving overlay as it goes. Returns { savedCount, failedCount }.
  async function uploadPending() {
    const toSend = state.photos.filter((p) => p.status !== 'done');
    els.savingOverlay.hidden = false;
    let done = state.photos.length - toSend.length;
    const total = state.photos.length;

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
      }
      renderThumbnails();
    }

    els.savingOverlay.hidden = true;
    return { savedCount: state.photos.filter((p) => p.status === 'done').length, failedCount: state.photos.filter((p) => p.status === 'failed').length };
  }

  async function runUploadAndShowResult() {
    const { savedCount, failedCount } = await uploadPending();
    const total = state.photos.length;

    if (failedCount === 0) {
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

  startScanScreen();
})();

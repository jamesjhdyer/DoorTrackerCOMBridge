// Continuous rear-camera capture for the iPad. These photographs can be
// evidence of a delivery's condition, so - unlike a typical web upload form -
// quality is favoured over a small file size: the network is the workshop's
// own local Wi-Fi, not the internet, and there is no server-side size limit
// to stay under (see http-server.js's much more generous maxPhotoBytes).
'use strict';

const DeliveryPhotoCamera = (() => {
  const IDEAL_WIDTH = 4032;
  const IDEAL_HEIGHT = 3024;
  const JPEG_QUALITY_STEPS = [0.9, 0.85, 0.75, 0.6]; // only steps down if a genuinely huge encode needs it

  // Opens the rear camera and attaches it to `video`, which keeps playing
  // continuously - the camera is opened ONCE per delivery, not per photo, so
  // taking another photograph is just "draw the current frame again".
  // Resolves once the video is actually producing frames (videoWidth/Height
  // are non-zero), so a caller can rely on real dimensions immediately after.
  async function openCamera(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('This browser cannot use the camera directly.'), { code: 'unsupported' });
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: IDEAL_WIDTH },
        height: { ideal: IDEAL_HEIGHT }
      }
    });
    video.srcObject = stream;
    video.setAttribute('playsinline', ''); // iOS Safari: without this it tries to go fullscreen
    video.muted = true;
    await video.play();
    if (!video.videoWidth) {
      await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
    }
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      stop() {
        for (const track of stream.getTracks()) track.stop();
        video.srcObject = null;
      }
    };
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }

  // Draws the CURRENT video frame onto `canvas` at the camera's own real
  // delivered resolution (never artificially shrunk) and encodes it as a
  // JPEG. If encoding at the normal quality would exceed `maxBytes` (very
  // unlikely at these settings, but photographs from an unusually high-
  // resolution device are not something to gamble on), quality steps down
  // - the image is never made smaller in PIXELS, only re-compressed.
  // Returns { blob, width, height }.
  async function capturePhoto(video, canvas, { maxBytes = 18 * 1000 * 1000 } = {}) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('The camera has not produced a frame yet.');

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, width, height);

    let blob = null;
    for (const quality of JPEG_QUALITY_STEPS) {
      blob = await canvasToBlob(canvas, quality);
      if (blob && blob.size <= maxBytes) break;
    }
    if (!blob) throw new Error('Could not encode the photograph.');
    return { blob, width, height };
  }

  return { openCamera, capturePhoto, IDEAL_WIDTH, IDEAL_HEIGHT };
})();

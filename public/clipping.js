// Live exposure warning drawn over the camera: pure white (255) in red and pure black (0) in blue.
// It is an overlay only; nothing here is ever written into the photograph.
const MAX_EDGE = 480, INTERVAL = 66;

export function markClipping(source, target) {
  for (let i = 0; i < source.length; i += 4) {
    // Same luminance as the saved black-and-white photo (processing.js).
    const gray = Math.round(.2126 * source[i] + .7152 * source[i + 1] + .0722 * source[i + 2]);
    if (gray >= 255) { target[i] = 255; target[i + 1] = 32; target[i + 2] = 32; target[i + 3] = 255; }
    else if (gray <= 0) { target[i] = 40; target[i + 1] = 110; target[i + 2] = 255; target[i + 3] = 255; }
    else target[i + 3] = 0;
  }
  return target;
}

export function clippingOverlay(video, canvas, alive) {
  const work = document.createElement('canvas');
  const reader = work.getContext('2d', { willReadFrequently: true, alpha: false }), painter = canvas.getContext('2d');
  const state = { enabled: false };
  let last = 0, output;
  const tick = time => {
    if (!alive()) { work.width = work.height = canvas.width = canvas.height = 0; return; }
    requestAnimationFrame(tick);
    if (!state.enabled || document.hidden || video.readyState < 2 || !video.videoWidth) { if (canvas.width) canvas.width = canvas.height = 0; return; }
    if (time - last < INTERVAL) return;
    last = time;
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
    if (work.width !== width || work.height !== height) { work.width = canvas.width = width; work.height = canvas.height = height; output = undefined; }
    if (canvas.width !== width) { canvas.width = width; canvas.height = height; output = undefined; }
    reader.drawImage(video, 0, 0, width, height);
    output ||= painter.createImageData(width, height);
    markClipping(reader.getImageData(0, 0, width, height).data, output.data);
    painter.putImageData(output, 0, 0);
  };
  requestAnimationFrame(tick);
  return state;
}

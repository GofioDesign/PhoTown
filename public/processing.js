// Provisional pilot settings: validate real mobile captures on the review display.
export const MAX_EDGE = 2560;
export const WEBP_QUALITY = 0.88;
export const MAX_BYTES = 5 * 1024 * 1024;

export function fitDimensions(width, height, maxEdge = MAX_EDGE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('La cámara aún no está lista. Espera un momento y vuelve a intentar.');
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function grayscale(pixels) {
  // Same luminance coefficients as CSS grayscale(1), used by the live preview.
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = Math.round(.2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]);
    pixels[i] = pixels[i + 1] = pixels[i + 2] = gray;
    pixels[i + 3] = 255;
  }
  return pixels;
}

export async function capture(video) {
  const { width, height } = fitDimensions(video.videoWidth, video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  if (!context) throw new Error('No se pudo preparar la fotografía en este navegador.');
  context.drawImage(video, 0, 0, width, height);
  const frame = context.getImageData(0, 0, width, height);
  grayscale(frame.data);
  context.putImageData(frame, 0, 0);
  // A new canvas encodes pixels only; no original camera EXIF/GPS is copied.
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY));
  canvas.width = canvas.height = 0;
  if (!blob || blob.type !== 'image/webp') throw new Error('Este navegador no puede guardar en el formato necesario. Prueba con una versión reciente de Safari, Chrome o Firefox.');
  if (blob.size > MAX_BYTES) throw new Error('La fotografía ocupa demasiado. Vuelve a fotografiar.');
  return { blob, id: crypto.randomUUID() };
}

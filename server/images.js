import { HttpError } from './security.js';
import { sanitizeWebP } from './webp.js';

function invalid() { throw new HttpError(415, 'No se reconoce la fotografía. Vuelve a capturarla desde PhoTown.'); }

// Baseline/progressive JPEG only. Rebuild the stream keeping the segments needed
// to decode it and drop EXIF/XMP/ICC/comments (APP1–APP13, APP15, COM).
// This validates the container structure, not the entropy-coded pixels.
export function sanitizeJPEG(bytes, maxEdge = 2560) {
  if (bytes.length < 128 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  const kept = [new Uint8Array([0xff, 0xd8])];
  let offset = 2, width, height, scan = -1;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) invalid();
    while (bytes[offset] === 0xff && offset < bytes.length) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (offset + 2 > bytes.length) invalid();
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    const start = offset - 2, end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (width || length < 8 || bytes[offset + 2] !== 8) invalid();
      height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (![1, 3].includes(bytes[offset + 7])) invalid();
      kept.push(bytes.subarray(start, end));
    } else if ((marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4) || marker === 0xde || marker === 0xdf) {
      invalid(); // lossless, hierarchical, arithmetic and other rare encodings
    } else if (marker === 0xda) {
      if (!width) invalid();
      scan = start; break;
    } else if ([0xdb, 0xc4, 0xdd].includes(marker) || marker === 0xe0 || marker === 0xee) {
      kept.push(bytes.subarray(start, end));
    } else if (!((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)) invalid();
    offset = end;
  }
  if (scan < 0 || !width || !height || width > maxEdge || height > maxEdge) invalid();
  let last = bytes.length;
  while (last > scan + 2 && bytes[last - 1] === 0) last--; // tolerate zero padding
  if (bytes[last - 2] !== 0xff || bytes[last - 1] !== 0xd9) invalid();
  kept.push(bytes.subarray(scan, last));
  const clean = new Uint8Array(kept.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of kept) { clean.set(part, position); position += part.length; }
  return { bytes: clean, width, height };
}

export const imageTypes = { 'image/webp': 'webp', 'image/jpeg': 'jpg' };
export function sanitizeImage(bytes, type, maxEdge = 2560) {
  if (type === 'image/webp') {
    const image = sanitizeWebP(bytes);
    if (image.width > maxEdge || image.height > maxEdge) invalid();
    return image;
  }
  if (type === 'image/jpeg') return sanitizeJPEG(bytes, maxEdge);
  throw new HttpError(415, 'Solo se admiten fotografías WebP o JPEG de PhoTown.');
}

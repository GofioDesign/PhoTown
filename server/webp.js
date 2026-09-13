import { HttpError } from './security.js';
const decoder = new TextDecoder();
function invalid() { throw new HttpError(415, 'No se reconoce la fotografía. Vuelve a capturarla desde PhoTown.'); }

// Accept only a still WebP bitstream. Strip extended headers and metadata by
// rebuilding a simple RIFF container. This is container validation, not a codec.
export function sanitizeWebP(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start, end) => decoder.decode(bytes.subarray(start, end));
  if (bytes.length < 30 || text(0, 4) !== 'RIFF' || text(8, 12) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) invalid();
  let frame;
  let width;
  let height;
  let extended;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid();
    const kind = text(offset, offset + 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end + (length % 2) > bytes.length) invalid();
    if (kind === 'VP8X') {
      if (extended || frame || offset !== 12 || length !== 10 || bytes[start] & 0x12) invalid(); // no animation/alpha
      extended = { width: 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16), height: 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16) };
    } else if (kind === 'VP8 ') {
      if (frame || length < 10 || (bytes[start] & 1) !== 0 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) invalid();
      width = view.getUint16(start + 6, true) & 0x3fff;
      height = view.getUint16(start + 8, true) & 0x3fff;
      frame = bytes.slice(offset, end + (length % 2));
    } else if (kind === 'VP8L') {
      if (frame || length < 5 || bytes[start] !== 0x2f) invalid();
      const bits = view.getUint32(start + 1, true);
      if (bits >>> 28) invalid(); // reject alpha and unsupported bitstream version
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      frame = bytes.slice(offset, end + (length % 2));
    } else if (!['EXIF', 'XMP ', 'ICCP'].includes(kind)) invalid();
    offset = end + (length % 2);
  }
  if (!frame || !width || !height || width > 2560 || height > 2560 || (extended && (width !== extended.width || height !== extended.height))) invalid();
  const clean = new Uint8Array(12 + frame.length);
  clean.set([82, 73, 70, 70], 0);
  new DataView(clean.buffer).setUint32(4, clean.length - 8, true);
  clean.set([87, 69, 66, 80], 8);
  clean.set(frame, 12);
  return { bytes: clean, width, height };
}

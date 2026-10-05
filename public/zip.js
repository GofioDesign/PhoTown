// Store original WebP files without recompressing them. Bounded, sequential reads
// keep multi-downloads within mobile memory limits and avoid browser popup limits.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zip(files) {
  const chunks = [], directory = []; let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name), checksum = crc32(file.bytes), size = file.bytes.length;
    const local = new Uint8Array(30 + name.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(12, 33, true); l.setUint32(14, checksum, true); l.setUint32(18, size, true); l.setUint32(22, size, true); l.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, 33, true); c.setUint32(16, checksum, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true); central.set(name, 46);
    chunks.push(local, file.bytes); directory.push(central); offset += local.length + size;
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, directory.reduce((sum, item) => sum + item.length, 0), true); e.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end], { type: 'application/zip' });
}
// Apply a moderator's display rotation to a downloaded copy. Unrotated photos are returned untouched.
export async function upright(bytes, rotation = 0) {
  if (!rotation) return bytes;
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
  const sideways = rotation % 180 !== 0, canvas = document.createElement('canvas');
  canvas.width = sideways ? bitmap.height : bitmap.width; canvas.height = sideways ? bitmap.width : bitmap.height;
  const context = canvas.getContext('2d');
  context.translate(canvas.width / 2, canvas.height / 2); context.rotate(rotation * Math.PI / 180);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2); bitmap.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .92));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('No se pudo preparar la fotografía girada.');
  return new Uint8Array(await blob.arrayBuffer());
}
export async function downloadPhoto(photo) {
  const response = await fetch(`/api/library/${photo.id}/download`, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error('No se pudo descargar la fotografía. Comprueba tu conexión y reintenta.');
  const bytes = await upright(new Uint8Array(await response.arrayBuffer()), photo.rotation);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' })), link = document.createElement('a');
  link.href = url; link.download = `photown-${photo.id}.webp`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function downloadArchive(photos, report) {
  const files = []; let total = 0;
  for (const photo of photos) {
    const response = await fetch(`/api/library/${photo.id}/download`, { signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new Error('No se pudo descargar una fotografía. Comprueba tu conexión y reintenta.');
    const bytes = await upright(new Uint8Array(await response.arrayBuffer()), photo.rotation); total += bytes.length;
    if (total > 100 * 1024 * 1024) throw new Error('La selección supera 100 MB. Descarga las fotos en grupos más pequeños.');
    files.push({ name: `photown-${photo.id}.webp`, bytes }); report(`Preparando descarga: ${files.length} de ${photos.length}…`);
  }
  const url = URL.createObjectURL(zip(files)), link = document.createElement('a');
  link.href = url; link.download = 'photown-mis-fotos.zip'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}

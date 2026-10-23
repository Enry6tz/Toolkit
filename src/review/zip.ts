/** A small standards-compliant STORE ZIP writer. No compression or runtime dependency. */
export interface ZipEntry { path: string; bytes: Uint8Array }

const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f:]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('ZIP_PATH_INVALID: la ruta del archivo no es relativa y segura.');
  }
}

/** UTF-8 filenames, CRC-32, local headers, central directory and EOCD (ZIP APPNOTE). */
export function createStoreZip(entries: readonly ZipEntry[], createdAt = new Date().toISOString()): Uint8Array {
  if (entries.length > 65_535) throw new Error('ZIP_LIMIT_REACHED: demasiados archivos para ZIP32.');
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) throw new Error('La fecha de exportación no es válida.');
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >>> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const names = new Set<string>();
  const prepared = entries.map(entry => {
    assertPath(entry.path);
    if (names.has(entry.path)) throw new Error('ZIP_PATH_DUPLICATE: el archivo está repetido.');
    names.add(entry.path);
    const name = encoder.encode(entry.path);
    if (name.length > 65_535 || entry.bytes.byteLength > 0xffffffff) throw new Error('ZIP_LIMIT_REACHED: el archivo excede ZIP32.');
    return { ...entry, name, crc: crc32(entry.bytes) };
  });
  const localSize = prepared.reduce((total, entry) => total + 30 + entry.name.length + entry.bytes.byteLength, 0);
  const centralSize = prepared.reduce((total, entry) => total + 46 + entry.name.length, 0);
  if (localSize + centralSize + 22 > 0xffffffff) throw new Error('ZIP_LIMIT_REACHED: el paquete excede ZIP32.');
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  const offsets: number[] = [];
  for (const entry of prepared) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, dosTime, true);
    view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.bytes.byteLength, true);
    view.setUint32(offset + 22, entry.bytes.byteLength, true);
    view.setUint16(offset + 26, entry.name.length, true);
    output.set(entry.name, offset + 30);
    output.set(entry.bytes, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.bytes.byteLength;
  }
  prepared.forEach((entry, index) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, dosTime, true);
    view.setUint16(offset + 14, dosDate, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.bytes.byteLength, true);
    view.setUint32(offset + 24, entry.bytes.byteLength, true);
    view.setUint16(offset + 28, entry.name.length, true);
    view.setUint32(offset + 42, offsets[index] ?? 0, true);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  });
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, localSize, true);
  return output;
}

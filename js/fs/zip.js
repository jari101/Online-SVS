// js/fs/zip.js — builds a .zip file in the browser, with no library.
//
// Firefox and Safari have no way to write to a folder on your disk: the API simply does not
// exist there, and no amount of code can add it. So instead of scattering loose files into
// your Downloads folder, "Save Folder" packs the whole thing — every file, in its subfolders,
// under the original folder's name — into one zip you unzip back over the original.
//
// Entries are *stored*, not compressed. A zip is allowed to hold plain bytes (method 0), and
// that keeps this file short and fast. The result is bigger than a compressed zip, but every
// unzip program reads it.

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const UTF8_NAMES = 0x0800;      // "the name below is UTF-8", so accents and emoji survive
const MSDOS_DIRECTORY = 0x10;   // external attribute that marks an entry as a folder
const LIMIT = 0xfffffffe;       // a plain zip counts in 32 bits; beyond this it needs Zip64

let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[i] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Zip stores the clock the way MS-DOS did in 1980: two packed 16-bit numbers. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data ?? ''));
}

/**
 * Pack entries into a zip.
 * @param {Array<{name: string, data?: *, dir?: boolean}>} entries names use "/" and are
 *        relative to the zip's root; a `dir` entry carries no data and just preserves a folder.
 * @returns {Blob}
 */
export function zip(entries, { modified = new Date() } = {}) {
  const encoder = new TextEncoder();
  const stamp = dosStamp(modified);
  const body = [];
  const directory = [];
  let offset = 0;
  let count = 0;

  for (const entry of entries) {
    const isDir = Boolean(entry.dir);
    const name = encoder.encode(isDir ? entry.name.replace(/\/*$/, '/') : entry.name);
    const data = isDir ? new Uint8Array(0) : toBytes(entry.data);
    if (data.length > LIMIT) throw new Error(`"${entry.name}" is too big to put in a zip.`);
    const crc = data.length ? crc32(data) : 0;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_HEADER, true);
    local.setUint16(4, 20, true);           // version needed to extract: 2.0
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true);            // method 0 = stored
    local.setUint16(10, stamp.time, true);
    local.setUint16(12, stamp.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); // compressed size == the real size
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);           // no extra field
    body.push(local.buffer, name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, CENTRAL_HEADER, true);
    central.setUint16(4, 20, true);         // version made by
    central.setUint16(6, 20, true);         // version needed
    central.setUint16(8, UTF8_NAMES, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, stamp.time, true);
    central.setUint16(14, stamp.date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint16(30, 0, true);         // extra field
    central.setUint16(32, 0, true);         // comment
    central.setUint16(34, 0, true);         // disk number
    central.setUint16(36, 0, true);         // internal attributes
    central.setUint32(38, isDir ? MSDOS_DIRECTORY : 0, true);
    central.setUint32(42, offset, true);    // where this entry's local header sits
    directory.push(central.buffer, name);

    offset += 30 + name.length + data.length;
    count++;
    if (offset > LIMIT) throw new Error('That folder is too big to put in a single zip.');
  }

  const directorySize = directory.reduce((total, part) => total + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END_OF_DIRECTORY, true);
  end.setUint16(4, 0, true);                // this disk
  end.setUint16(6, 0, true);                // the disk the directory starts on
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);               // no zip comment

  return new Blob([...body, ...directory, end.buffer], { type: 'application/zip' });
}

/**
 * The same, but everything ends up inside one top-level folder named after your folder, so
 * unzipping next to the original merges the files straight back into it.
 */
export function zipFolder(rootName, { files = [], dirs = [] } = {}) {
  const root = rootName.replace(/[\\/:*?"<>|]/g, '_') || 'folder';
  const entries = [{ name: root, dir: true }];
  for (const path of dirs) if (path) entries.push({ name: `${root}/${path}`, dir: true });
  for (const { path, data } of files) entries.push({ name: `${root}/${path}`, data });
  return { blob: zip(entries), name: `${root}.zip` };
}

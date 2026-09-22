// js/fs/unzip.js — reads a .zip file in the browser, with no library.
//
// The other half of js/fs/zip.js: that one packs a folder up, this one takes one apart, so a
// folder can be opened from a zip and written back into the same zip afterwards.
//
// A zip is read from the back. At the very end sits the "end of central directory" record,
// which says how many entries there are and where the list of them starts. That list — the
// central directory — is the authoritative one: it holds each entry's name, its sizes and the
// offset of its bytes. Reading it means we never have to guess our way forward through the file.
//
// Two kinds of entry are understood, which between them covers every zip you are likely to meet:
//   method 0 (stored)   — plain bytes, the kind js/fs/zip.js writes
//   method 8 (deflate)  — what Windows, macOS, 7-Zip and every other zip tool produces
// Deflate is undone by DecompressionStream, which the browser already has. Still no library.

import { crc32 } from './zip.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED = 0x0001;        // general-purpose flag bit 0: the entry needs a password
const UTF8_NAMES = 0x0800;       // flag bit 11: the name below is UTF-8
const MSDOS_DIRECTORY = 0x10;    // external attribute that marks an entry as a folder
const NEEDS_ZIP64 = 0xffffffff;  // a size or offset too big for a plain zip to write down
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;      // a zip may end with a comment, so the record is not always last

/** True when this browser can undo deflate compression (every current one can). */
export const canDecompress = (() => {
  if (typeof DecompressionStream !== 'function') return false;
  try {
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false; // the format exists but this browser does not know 'deflate-raw'
  }
})();

/** Does this name look like a zip? Used to offer "open it as a project" instead of a tab. */
export function isZipPath(path) {
  return /\.zip$/i.test(path);
}

/**
 * Take a zip apart.
 * @param {Blob|File|ArrayBuffer|Uint8Array} source the zip's bytes
 * @returns {Promise<{files: Map<string, ArrayBuffer>, dirs: string[]}>} paths use "/" and are
 *          relative to the zip's own root, exactly like the paths the rest of the app uses.
 */
export async function unzip(source) {
  const bytes = await toBytes(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfDirectory(view, bytes.length);

  const count = view.getUint16(end + 10, true);
  const directoryAt = view.getUint32(end + 16, true);
  if (count === MAX_COMMENT || directoryAt === NEEDS_ZIP64) {
    throw new Error('This zip is in the Zip64 format (over 4 GB, or more than 65,535 files), which this app cannot read.');
  }
  if (directoryAt >= bytes.length) throw new Error('This zip is damaged: its list of files points past the end of the file.');

  const files = new Map();
  const dirs = [];
  let at = directoryAt;

  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_HEADER) {
      throw new Error(`This zip is damaged: entry ${i + 1} of ${count} could not be found.`);
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const attributes = view.getUint32(at + 38, true);
    const dataAt = view.getUint32(at + 42, true);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    const name = decodeName(rawName, flags);
    const path = cleanPath(name);
    if (path === null) continue; // a name that tries to climb out of the zip; nothing good is in it

    // Folders are written either as a name ending in "/" or with the MS-DOS directory bit.
    if (!path || name.endsWith('/') || (attributes & MSDOS_DIRECTORY && !size)) {
      if (path) dirs.push(path);
      continue;
    }

    if (flags & ENCRYPTED) throw new Error(`"${path}" is password-protected, and this app cannot unlock it.`);
    if (method !== STORED && method !== DEFLATED) {
      throw new Error(`"${path}" uses compression method ${method}, which this app cannot read. Re-zip the folder with the normal setting.`);
    }
    if (size === NEEDS_ZIP64 || packedSize === NEEDS_ZIP64) {
      throw new Error(`"${path}" is over 4 GB, which needs the Zip64 format this app cannot read.`);
    }

    const packed = entryBytes(view, bytes, dataAt, packedSize, path);
    const data = method === DEFLATED ? await inflateRaw(packed, path) : packed;
    if (data.length !== size) {
      throw new Error(`"${path}" is damaged: it should hold ${size} bytes but unpacked to ${data.length}.`);
    }
    if (size && crc32(data) !== crc) {
      throw new Error(`"${path}" is damaged: its contents do not match the checksum stored in the zip.`);
    }
    // A copy of just this entry's bytes, so the whole zip can be let go of afterwards.
    files.set(path, data.slice().buffer);
  }

  return { files, dirs };
}

/* ---------- Finding the pieces ---------- */

/**
 * The end-of-central-directory record is the last thing in the file, except that a zip may
 * carry a comment after it — so it is looked for from the back, as far as a comment can reach.
 */
function findEndOfDirectory(view, length) {
  if (length < EOCD_SIZE) throw new Error('That file is too small to be a zip.');
  const earliest = Math.max(0, length - EOCD_SIZE - MAX_COMMENT);
  for (let at = length - EOCD_SIZE; at >= earliest; at--) {
    if (view.getUint32(at, true) !== END_OF_DIRECTORY) continue;
    // Guard against the signature turning up inside compressed data: the comment length
    // recorded here has to account for exactly the bytes that follow.
    if (view.getUint16(at + 20, true) === length - at - EOCD_SIZE) return at;
  }
  throw new Error('That does not look like a zip file — the end of its file list is missing.');
}

/**
 * Where an entry's bytes actually begin. The central directory gives the offset of the entry's
 * *local* header, and that header's own name and extra field can be a different length, so the
 * data's start has to be worked out from the local header rather than assumed.
 */
function entryBytes(view, bytes, headerAt, packedSize, path) {
  if (headerAt + 30 > bytes.length || view.getUint32(headerAt, true) !== LOCAL_HEADER) {
    throw new Error(`This zip is damaged: the header for "${path}" is missing.`);
  }
  const nameLength = view.getUint16(headerAt + 26, true);
  const extraLength = view.getUint16(headerAt + 28, true);
  const start = headerAt + 30 + nameLength + extraLength;
  if (start + packedSize > bytes.length) {
    throw new Error(`This zip is cut short: "${path}" runs past the end of the file.`);
  }
  return bytes.subarray(start, start + packedSize);
}

async function inflateRaw(packed, path) {
  if (!canDecompress) {
    throw new Error(`"${path}" is compressed, and this browser cannot undo it. Try Chrome, Edge, a current Firefox or Safari 16.4 or newer.`);
  }
  try {
    const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error(`"${path}" could not be unpacked: its compressed data is damaged.`);
  }
}

/* ---------- Names ---------- */

/**
 * Entry names are UTF-8 when the zip says so. Older tools wrote them in the code page of the
 * machine that made the zip, which we cannot know, so those are read as Windows-1252 — right
 * for the accented letters of Western Europe, and never worse than a row of question marks.
 */
function decodeName(raw, flags) {
  if (flags & UTF8_NAMES) return new TextDecoder().decode(raw);
  const utf8 = new TextDecoder().decode(raw);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(raw) : utf8;
}

/**
 * Turn an entry name into one of our paths: "/" separators, no leading slash, no "." or "..".
 * Returns null for a name that tries to point outside the zip, which no honest zip does.
 */
function cleanPath(name) {
  const parts = [];
  for (const part of name.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.join('/');
}

async function toBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer()); // File is a Blob
  throw new Error('A zip can only be read from a file or its bytes.');
}

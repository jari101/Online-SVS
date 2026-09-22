// js/fs/index.js — the one place the rest of the app talks to when it needs files.
// It picks the right backend (real folder on disk, or memory) and forwards calls to it.

import * as native from './native.js';
import * as memory from './memory.js';
import { unzip } from './unzip.js';
import { isIgnoredPath } from './util.js';
import { SAMPLE_FILES, SAMPLE_NAME } from './sample.js';

export { isBinaryPath, isImagePath, findNode, parentOf, baseName, join, validateName, extOf, mimeFor } from './util.js';
export { isZipPath } from './unzip.js';

let backend = null;

/** True in Chrome/Edge/Opera/Brave: folders can be opened and saved back to disk. */
export const supportsNative = native.supported;

export function current() {
  return backend;
}

export function hasFolder() {
  return backend !== null;
}

export function setCurrent(next) {
  backend = next;
}

export function closeFolder() {
  backend = null;
}

/**
 * Ask the user for a folder. Resolves to a backend, or null if they cancelled.
 * It does NOT become the current folder until setCurrent() is called: the caller
 * may first need to ask about unsaved changes in the folder that is open now.
 */
export async function pickFolder() {
  if (supportsNative) return native.pick();
  return memory.pickWithInput(document.getElementById('folder-input'));
}

/**
 * Build a backend around a folder handle remembered from an earlier visit, so the same
 * folder on disk opens again without going through the picker. Native browsers only.
 */
export function folderFromHandle(handle) {
  return native.fromHandle(handle);
}

/** The handle of the open folder, when there is one that can be remembered. */
export function folderHandle() {
  return backend?.handle || null;
}

/* ---------- Opening a .zip as a folder ---------- */

/**
 * Ask the user for a .zip. Resolves to `{ file, handle }` — the handle is what lets Save Folder
 * write the edits back into that same zip, and is null in browsers that cannot offer one.
 * Null overall when the user cancels.
 */
export async function pickZip() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({
        id: 'svs-zip',
        multiple: false,
        types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
      });
      return { file: await handle.getFile(), handle };
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      throw err;
    }
  }
  const file = await pickWithInput(document.getElementById('zip-input'));
  return file ? { file, handle: null } : null;
}

/** Fallback zip picker for Firefox and Safari: a hidden <input type="file" accept=".zip">. */
function pickWithInput(input) {
  return new Promise((resolve) => {
    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
    };
    const onChange = () => {
      cleanup();
      const file = input.files[0] || null;
      input.value = ''; // so picking the same file again still fires 'change'
      resolve(file);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}

/**
 * Open a zip's contents as a folder. The files live in memory; `zip` remembers the file they
 * came out of so Save Folder can put them straight back.
 * @param {Blob|File|ArrayBuffer|Uint8Array} source the zip's bytes
 * @param {FileSystemFileHandle|null} [options.handle] the zip on disk, when we may write to it
 * @param {string} [options.fileName] its name, when `source` carries none of its own
 */
export async function folderFromZip(source, { handle = null, fileName = null } = {}) {
  const name = fileName || source?.name || 'archive.zip';
  const unpacked = await unzip(source);
  if (!unpacked.files.size) throw new Error(`"${name}" holds no files, so there is nothing to open.`);

  // Drop the folders the explorer never shows first. macOS puts a "__MACOSX" folder in every
  // zip it makes, and leaving it in would hide the one real folder there is to open at the root.
  const files = new Map([...unpacked.files].filter(([path]) => !isIgnoredPath(path)));
  const dirs = unpacked.dirs.filter((path) => !isIgnoredPath(path));
  if (!files.size) throw new Error(`"${name}" holds nothing this app can open.`);

  const peeled = peelSingleFolder(files, dirs);
  return memory.fromFiles(
    peeled ? peeled.name : name.replace(/\.zip$/i, '') || name,
    peeled ? peeled.files : files,
    {
      dirs: peeled ? peeled.dirs : dirs,
      // `wrapped` records the shape we found, so writing back produces the same shape again.
      zip: { handle, fileName: name, wrapped: Boolean(peeled) },
    },
  );
}

/**
 * Most zips hold a single folder — "hello.zip" unzips to "hello/index.html" — including every
 * zip this app writes. Peeling that folder off makes it the project root, so index.html is
 * where you expect it and a zip saved from here reopens exactly as it was. A zip with several
 * things at the top level has no such folder to peel, and is left as it is.
 */
function peelSingleFolder(files, dirs) {
  const top = (path) => path.split('/')[0];
  const tops = new Set([...files.keys(), ...dirs].map(top));
  if (tops.size !== 1) return null;

  const [root] = [...tops];
  if (files.has(root)) return null; // one lone file at the root, not a folder

  const strip = (path) => path.slice(root.length + 1);
  return {
    name: root,
    files: new Map([...files].map(([path, data]) => [strip(path), data])),
    dirs: dirs.filter((path) => path !== root).map(strip),
  };
}

/** The .zip the open folder was read from, or null when it did not come from one. */
export function zipSource() {
  return backend?.zip || null;
}

/** A handle to one file in the open folder, when the browser can give one out. */
export function fileHandleFor(path) {
  return need().fileHandleFor?.(path) || null;
}

/* ---------- Opening a folder that was dragged onto the window ---------- */

/** How many files a dropped folder may hold. Past this it is almost certainly a mistake. */
const MAX_DROPPED_FILES = 4000;

/**
 * Read a folder that was dropped on the window in a browser without the File System Access
 * API (Firefox, Safari). All it gives out is the old `webkitGetAsEntry` interface, which can
 * be walked but not written to, so the folder opens read-only — the same as Open Folder there.
 */
export async function folderFromDirectoryEntry(entry) {
  const files = new Map();
  await readDirectoryEntry(entry, '', files);
  if (!files.size) throw new Error(`"${entry.name}" holds nothing this app can open.`);
  return memory.fromFiles(entry.name, files, { readOnly: true });
}

/** Turn readEntries' callbacks into something `await` understands. */
function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(fileEntry) {
  return new Promise((resolve, reject) => fileEntry.file(resolve, reject));
}

async function readDirectoryEntry(dirEntry, prefix, files) {
  const reader = dirEntry.createReader();
  // readEntries hands out children a batch at a time; an empty batch means that was the lot.
  for (;;) {
    const batch = await readEntries(reader);
    if (!batch.length) return;
    for (const child of batch) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (isIgnoredPath(path)) continue;
      if (child.isDirectory) {
        await readDirectoryEntry(child, path, files);
      } else {
        if (files.size >= MAX_DROPPED_FILES) {
          throw new Error(`That folder holds more than ${MAX_DROPPED_FILES} files, which is too many to read this way.`);
        }
        files.set(path, await fileOf(child));
      }
    }
  }
}

/** A fresh copy of the built-in sample website. */
export function sampleFolder() {
  return memory.fromFiles(SAMPLE_NAME, SAMPLE_FILES, { readOnly: false, sample: true });
}

function need() {
  if (!backend) throw new Error('No folder is open.');
  return backend;
}

export const tree = () => need().tree();
export const readText = (path) => need().readText(path);
export const readBinary = (path) => need().readBinary(path);
export const writeText = (path, text) => need().writeText(path, text);
export const createFile = (dir, name) => need().createFile(dir, name);
export const createDir = (dir, name) => need().createDir(dir, name);
export const exists = (path) => need().exists(path);
export const remove = (path) => need().remove(path);
export const rename = (path, newName) => need().rename(path, newName);
export const stat = (path) => need().stat(path);
export const countFiles = (path, limit) => need().countFiles(path, limit);

/**
 * Everything in the open folder, ready to be packed into a zip: the bytes of every file and
 * the path of every folder (so an empty folder survives the round trip too).
 */
export async function snapshot() {
  const backend = need();
  const filePaths = [];
  const dirs = [];
  (function walk(node) {
    if (node.kind === 'file') {
      filePaths.push(node.path);
      return;
    }
    if (node.path) dirs.push(node.path);
    for (const child of node.children) walk(child);
  })(await backend.tree());

  const files = [];
  for (const path of filePaths) {
    files.push({ path, data: new Uint8Array(await backend.readBinary(path)) });
  }
  return { name: backend.name, files, dirs };
}

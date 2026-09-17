// js/fs/index.js — the one place the rest of the app talks to when it needs files.
// It picks the right backend (real folder on disk, or memory) and forwards calls to it.

import * as native from './native.js';
import * as memory from './memory.js';
import { SAMPLE_FILES, SAMPLE_NAME } from './sample.js';

export { isBinaryPath, findNode, parentOf, baseName, join, validateName } from './util.js';

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

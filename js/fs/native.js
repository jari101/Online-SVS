// js/fs/native.js — reads and writes a real folder on the user's computer with the
// File System Access API (Chrome, Edge, Opera, Brave). The browser asks for permission
// once; after that, saving writes straight to disk like VS Code. Nothing leaves the PC.

import { CONFIG } from '../config.js';
import { segments, join, sortNodes, parentOf, baseName } from './util.js';

export const supported = typeof window.showDirectoryPicker === 'function';

/** Show the folder picker. Resolves to a backend, or null when the user cancels. */
export async function pick() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    return createBackend(handle);
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    throw err;
  }
}

function createBackend(root) {
  async function dirHandle(path, create = false) {
    let dir = root;
    for (const seg of segments(path)) dir = await dir.getDirectoryHandle(seg, { create });
    return dir;
  }

  async function fileHandle(path, create = false) {
    const dir = await dirHandle(parentOf(path), create);
    return dir.getFileHandle(baseName(path), { create });
  }

  return {
    kind: 'native',
    name: root.name,
    readOnly: false,
    sample: false,

    tree: () => buildTree(root, ''),

    async readText(path) {
      const file = await (await fileHandle(path)).getFile();
      return file.text();
    },

    async readBinary(path) {
      const file = await (await fileHandle(path)).getFile();
      return file.arrayBuffer();
    },

    async lastModified(path) {
      const file = await (await fileHandle(path)).getFile();
      return file.lastModified;
    },

    async writeText(path, text) {
      const handle = await fileHandle(path, true);
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },

    async createFile(dir, name) {
      const parent = await dirHandle(dir, true);
      await parent.getFileHandle(name, { create: true });
      return join(dir, name);
    },

    async createDir(dir, name) {
      const parent = await dirHandle(dir, true);
      await parent.getDirectoryHandle(name, { create: true });
      return join(dir, name);
    },

    async exists(path) {
      try { await fileHandle(path); return true; } catch { /* not a file */ }
      try { await dirHandle(path); return true; } catch { return false; }
    },

    async remove(path) {
      const parent = await dirHandle(parentOf(path));
      await parent.removeEntry(baseName(path), { recursive: true });
    },
  };
}

async function buildTree(dir, path) {
  const children = [];
  for await (const [name, handle] of dir.entries()) {
    if (CONFIG.ignoredNames.includes(name)) continue;
    const childPath = join(path, name);
    if (handle.kind === 'directory') {
      children.push(await buildTree(handle, childPath));
    } else {
      children.push({ name, path: childPath, kind: 'file' });
    }
  }
  return { name: dir.name, path, kind: 'dir', children: sortNodes(children) };
}

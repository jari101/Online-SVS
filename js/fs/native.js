// js/fs/native.js — reads and writes a real folder on the user's computer with the
// File System Access API (Chrome, Edge, Opera, Brave). The browser asks for permission
// once; after that, saving writes straight to disk like VS Code. Nothing leaves the PC.

import { CONFIG } from '../config.js';
import { segments, join, sortNodes, parentOf, baseName } from './util.js';

export const supported = typeof window.showDirectoryPicker === 'function';

/** Show the folder picker. Resolves to a backend, or null when the user cancels. */
export async function pick() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'svs-folder' });
    return fromHandle(handle);
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    throw err;
  }
}

/**
 * Build a backend around a folder handle. Used by the picker above and, when you come back
 * to the site, by the handle remembered from last time — that is what lets the same folder
 * reopen without picking it again.
 */
export function fromHandle(root) {
  async function dirHandle(path, create = false) {
    let dir = root;
    for (const seg of segments(path)) dir = await dir.getDirectoryHandle(seg, { create });
    return dir;
  }

  async function fileHandle(path, create = false) {
    const dir = await dirHandle(parentOf(path), create);
    return dir.getFileHandle(baseName(path), { create });
  }

  /** The handle of a path, whether it is a file or a folder. */
  async function anyHandle(path) {
    try {
      return await fileHandle(path);
    } catch {
      return dirHandle(path);
    }
  }

  return {
    kind: 'native',
    name: root.name,
    readOnly: false,
    sample: false,
    handle: root,   // stored (not the path — a handle reveals nothing on its own) so it can be reopened later

    tree: () => buildTree(root, ''),

    async readText(path) {
      const file = await (await fileHandle(path)).getFile();
      return file.text();
    },

    async readBinary(path) {
      const file = await (await fileHandle(path)).getFile();
      return file.arrayBuffer();
    },

    /** Size and modification time of one file. The watcher and the image tab both use it. */
    async stat(path) {
      const file = await (await fileHandle(path)).getFile();
      return { size: file.size, lastModified: file.lastModified };
    },

    /**
     * A handle to one file inside the folder. Opening a .zip that sits in the folder uses it,
     * so that saving can write the zip back into the very file it was opened from.
     */
    fileHandleFor(path) {
      return fileHandle(path);
    },

    async writeText(path, text) {
      const handle = await fileHandle(path, true);
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },

    async createFile(dir, name) {
      const parent = await dirHandle(dir, true);
      if (await entryExists(parent, name)) throw new Error(`"${name}" already exists.`);
      await parent.getFileHandle(name, { create: true });
      return join(dir, name);
    },

    async createDir(dir, name) {
      const parent = await dirHandle(dir, true);
      if (await entryExists(parent, name)) throw new Error(`"${name}" already exists.`);
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

    /**
     * Give a file or folder a new name, in the folder it already sits in.
     *
     * A file is renamed with `handle.move()` where the browser has it (Chrome and Edge do):
     * the file keeps its contents and never leaves the disk. Everywhere else, and for every
     * folder — no browser has move() for folders yet — it is copied under the new name and
     * the old one is then deleted, which is why renaming a big folder takes a moment.
     */
    async rename(path, newName) {
      const parentPath = parentOf(path);
      const target = join(parentPath, newName);
      if (target === path) return path;

      const parent = await dirHandle(parentPath);
      if (await entryExists(parent, newName)) throw new Error(`"${newName}" already exists.`);

      const handle = await anyHandle(path);
      if (handle.kind === 'file' && typeof handle.move === 'function') {
        await handle.move(newName);
        return target;
      }
      if (handle.kind === 'file') {
        await copyFile(handle, parent, newName);
      } else {
        try {
          await copyTree(handle, parent, newName);
        } catch (err) {
          // Leave no half-copied folder behind for the user to clean up by hand.
          await parent.removeEntry(newName, { recursive: true }).catch(() => {});
          throw err;
        }
      }
      await parent.removeEntry(baseName(path), { recursive: true });
      return target;
    },

    /** How many files are inside a folder, counting up to `limit`. Renaming asks first when it is a lot. */
    countFiles(path, limit) {
      return dirHandle(path).then((dir) => countFilesIn(dir, limit));
    },
  };
}

async function copyFile(handle, destDir, name) {
  const file = await handle.getFile();
  const copy = await destDir.getFileHandle(name, { create: true });
  const writable = await copy.createWritable();
  await writable.write(await file.arrayBuffer());
  await writable.close();
}

/** Copy a whole folder, including the names the explorer hides: a rename must lose nothing. */
async function copyTree(srcDir, destParent, name) {
  const dest = await destParent.getDirectoryHandle(name, { create: true });
  for await (const [childName, handle] of srcDir.entries()) {
    if (handle.kind === 'directory') await copyTree(handle, dest, childName);
    else await copyFile(handle, dest, childName);
  }
}

async function countFilesIn(dir, limit) {
  let count = 0;
  for await (const [, handle] of dir.entries()) {
    count += handle.kind === 'directory' ? await countFilesIn(handle, limit - count) : 1;
    if (count >= limit) return count;
  }
  return count;
}

/** getFileHandle/getDirectoryHandle with {create:true} silently return an existing entry, so check first. */
async function entryExists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch { /* not a file */ }
  try { await dir.getDirectoryHandle(name); return true; } catch { return false; }
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

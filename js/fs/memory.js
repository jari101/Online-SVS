// js/fs/memory.js — a folder that lives only in the browser tab's memory.
// Used for the built-in sample project and as the read-only fallback in browsers that
// lack the File System Access API (Firefox, Safari): files are read through a normal
// <input type="file" webkitdirectory>, edits stay in memory, and "Save" downloads the file.

import { CONFIG } from '../config.js';
import { segments, join, sortNodes, parentOf, baseName } from './util.js';

/**
 * Build a memory backend.
 * @param {string} name       folder name shown in the explorer
 * @param {Map|Object} files  path -> string | ArrayBuffer | File
 */
export function fromFiles(name, files, { readOnly = false, sample = false } = {}) {
  const entries = new Map(); // path -> { data }
  const dirs = new Set(['']);

  const addAncestors = (path) => {
    const segs = segments(path);
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  };

  const list = files instanceof Map ? files : Object.entries(files);
  for (const [path, data] of list) {
    if (segments(path).some((s) => CONFIG.ignoredNames.includes(s))) continue;
    entries.set(path, { data });
    addAncestors(path);
  }

  const decoder = new TextDecoder();

  function get(path) {
    const entry = entries.get(path);
    if (!entry) throw new Error(`File not found: ${path}`);
    return entry;
  }

  return {
    kind: 'memory',
    name,
    readOnly,
    sample,

    async tree() {
      return buildTree(name, entries, dirs);
    },

    async readText(path) {
      const { data } = get(path);
      if (typeof data === 'string') return data;
      if (data instanceof Blob) return data.text();
      return decoder.decode(data);
    },

    async readBinary(path) {
      const { data } = get(path);
      if (typeof data === 'string') return new TextEncoder().encode(data).buffer;
      if (data instanceof Blob) return data.arrayBuffer();
      return data;
    },

    async lastModified() {
      return 0;
    },

    async writeText(path, text) {
      entries.set(path, { data: text });
      addAncestors(path);
    },

    async createFile(dir, fileName) {
      const path = join(dir, fileName);
      if (entries.has(path) || dirs.has(path)) throw new Error(`"${fileName}" already exists.`);
      entries.set(path, { data: '' });
      addAncestors(path);
      return path;
    },

    async createDir(dir, dirName) {
      const path = join(dir, dirName);
      if (entries.has(path) || dirs.has(path)) throw new Error(`"${dirName}" already exists.`);
      dirs.add(path);
      addAncestors(path);
      return path;
    },

    async exists(path) {
      return entries.has(path) || dirs.has(path);
    },

    async remove(path) {
      entries.delete(path);
      dirs.delete(path);
      for (const key of [...entries.keys()]) if (key.startsWith(path + '/')) entries.delete(key);
      for (const d of [...dirs]) if (d.startsWith(path + '/')) dirs.delete(d);
    },

    /** Every file path (used by the live server in Phase 2). */
    paths() {
      return [...entries.keys()];
    },
  };
}

function buildTree(rootName, entries, dirs) {
  const nodes = new Map([['', { name: rootName, path: '', kind: 'dir', children: [] }]]);

  const dirNode = (path) => {
    if (nodes.has(path)) return nodes.get(path);
    const node = { name: baseName(path), path, kind: 'dir', children: [] };
    nodes.set(path, node);
    dirNode(parentOf(path)).children.push(node);
    return node;
  };

  for (const d of dirs) if (d) dirNode(d);
  for (const path of entries.keys()) {
    dirNode(parentOf(path)).children.push({ name: baseName(path), path, kind: 'file' });
  }
  for (const node of nodes.values()) sortNodes(node.children);
  return nodes.get('');
}

/**
 * Fallback folder picker: a hidden <input type="file" webkitdirectory>.
 * Resolves to a read-only memory backend, or null when the user cancels.
 */
export function pickWithInput(input) {
  return new Promise((resolve) => {
    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
    };
    const onChange = () => {
      cleanup();
      const files = [...input.files];
      input.value = '';
      if (!files.length) {
        resolve(null);
        return;
      }

      const firstPath = files[0].webkitRelativePath || files[0].name;
      const rootName = firstPath.includes('/') ? firstPath.split('/')[0] : 'folder';
      const map = new Map();
      for (const file of files) {
        const rel = file.webkitRelativePath || file.name;
        const path = rel.startsWith(rootName + '/') ? rel.slice(rootName.length + 1) : rel;
        map.set(path, file);
      }
      resolve(fromFiles(rootName, map, { readOnly: true }));
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

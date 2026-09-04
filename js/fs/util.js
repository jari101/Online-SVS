// js/fs/util.js — helpers shared by both file-system backends.
// Paths are always relative to the opened folder, use "/" and have no leading slash ("css/style.css").

export function segments(path) {
  return path.split('/').filter(Boolean);
}

export function join(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

export function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function baseName(path) {
  return path.split('/').pop();
}

export function extOf(path) {
  const name = baseName(path);
  return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'tif', 'tiff',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov', 'avi',
  'exe', 'dll', 'so', 'class', 'o', 'wasm',
]);

/** Files we should not open in the text editor. */
export function isBinaryPath(path) {
  return BINARY_EXTENSIONS.has(extOf(path));
}

/** Folders first, then alphabetical (case-insensitive) — the same order VS Code uses. */
export function sortNodes(nodes) {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
  return nodes;
}

/** Find a node in a tree by path. */
export function findNode(tree, path) {
  if (!tree) return null;
  if (tree.path === path) return tree;
  if (tree.kind !== 'dir') return null;
  for (const child of tree.children) {
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return null;
}

/** A simple name check for new files and folders. Returns an error message or null. */
export function validateName(name) {
  if (!name || !name.trim()) return 'A name is required.';
  if (/[\\/:*?"<>|]/.test(name)) return 'Names cannot contain \\ / : * ? " < > |';
  if (name === '.' || name === '..') return 'That name is reserved.';
  return null;
}

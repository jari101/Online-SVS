// js/explorer.js — the file tree in the sidebar: folders you can expand, files you can
// click to open, the "new file / new folder" inline inputs, and the right-click menu
// (Rename, Delete, Copy Path).
// Keyboard: Up/Down move, Right expands, Left collapses (or goes to the parent), Enter opens,
// F2 renames, Delete deletes, Shift+F10 (or the Menu key) opens the same menu as a right-click.

import { state, on, emit } from './state.js';
import * as fs from './fs/index.js';
import { openFile, retargetOpenFiles, closeFilesUnder, markNeedsExport } from './editor.js';
import { icons, treeIcons, fileTypeClass } from './icons.js';
import { escapeHtml, el } from './dom.js';
import { toast } from './toast.js';
import { confirmDialog } from './dialog.js';
import { openContextMenu } from './contextmenu.js';

/** Renaming a folder in a real folder on disk copies its files, so a big one asks first. */
const LARGE_FOLDER = 200;

const expanded = new Set(['']); // paths of folders that are open ('' is the root)
let host = null;
let selectedPath = '';           // the last row you clicked
let selectedDir = '';            // where a new file or folder will be created
let focusedPath = null;          // the row that receives keyboard focus (roving tabindex)
let creating = null;             // { kind: 'file' | 'dir', dir } while the inline input is shown
let renaming = null;             // { path, name } while a row has been turned into a name box
let openZip = null;              // main.js hands us the function that opens a .zip as a project

export function initExplorer(container, { openZip: open } = {}) {
  host = container;
  openZip = open;
  on('folder', render);
  on('tree', render);
  on('active', updateActiveRow);
  on('editor-ready', render);
  render();
}

/** Re-read the folder from disk (or memory) and redraw the tree. */
export async function refreshTree() {
  if (!fs.hasFolder()) {
    state.tree = null;
    emit('tree');
    return;
  }
  try {
    state.tree = await fs.tree();
  } catch (err) {
    console.error(err);
    toast(`Unable to read the folder: ${err.message}. Try Refresh Explorer, or open the folder again.`, 'error');
    state.tree = null;
  }
  emit('tree');
}

/** Show an inline input to create a file or folder inside the selected folder. */
export function startCreate(kind) {
  if (!fs.hasFolder() || !state.tree) return;
  renaming = null;
  creating = { kind, dir: selectedDir };
  expanded.add(selectedDir);
  render();
  host.querySelector('.tree-input')?.focus();
}

export function collapseAll() {
  expanded.clear();
  expanded.add('');
  render();
}

export function resetExplorer() {
  expanded.clear();
  expanded.add('');
  selectedPath = '';
  selectedDir = '';
  focusedPath = null;
  creating = null;
  renaming = null;
}

/** Turn a row into a name box, filled in with the name it has now. */
export function startRename(path) {
  if (!path || !fs.hasFolder() || !state.tree) return;
  if (!fs.findNode(state.tree, path)) return;
  creating = null;
  renaming = { path, name: fs.baseName(path) };
  render();
  const input = host.querySelector('.tree-input');
  if (!input) return;
  input.focus();
  // Select the name but not the extension, so typing replaces "logo" and keeps ".png".
  const dot = input.value.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
}

/* ---------- Rendering ---------- */

function render() {
  if (!host) return;
  const previousTree = host.querySelector('.tree');
  const scrollTop = previousTree ? previousTree.scrollTop : 0;
  const hadFocus = previousTree ? previousTree.contains(document.activeElement) : false;

  host.innerHTML = '';
  if (!fs.hasFolder()) {
    renderEmpty();
    return;
  }
  if (!state.tree) {
    host.innerHTML = '<h2 class="sidebar-title">Explorer</h2><div class="explorer-empty"><p class="muted">Loading folder…</p></div>';
    return;
  }

  const tree = renderTree();
  host.append(renderTitle(), renderHeader(), tree);
  tree.scrollTop = scrollTop;
  if (hadFocus) tree.querySelector('.tree-row[tabindex="0"]')?.focus();
}

/**
 * Another file became active. Only the highlight changes, so repaint the rows in place: a full
 * render() would rebuild every row's SVG and steal the focus the editor has just taken.
 * Mirrors the class logic at the end of renderRow().
 */
function updateActiveRow() {
  if (!host) return;
  for (const row of host.querySelectorAll('.tree-row[data-path]')) {
    const isActive = row.dataset.path === state.activePath;
    const isSelected = row.dataset.path === selectedPath;
    row.classList.toggle('active', isActive);
    row.classList.toggle('selected', !isActive && isSelected);
    row.setAttribute('aria-selected', String(isActive || isSelected));
  }
}

function renderTitle() {
  return el('h2', 'sidebar-title', 'Explorer');
}

function renderEmpty() {
  const support = fs.supportsNative
    ? 'Your browser can save changes straight back to the folder on your disk.'
    : 'This browser cannot write to your disk (Chrome, Edge or Opera can). A folder opens read-only here, and Save Folder packs your edits back into a zip to unzip over the original.';
  const disabled = state.editorReady ? '' : 'disabled';
  host.innerHTML = `
    <h2 class="sidebar-title">Explorer</h2>
    <div class="explorer-empty">
      <p>No folder is open yet.</p>
      <button class="btn" data-command="open-folder" ${disabled}>Open Folder</button>
      <p class="muted small">Your files stay on your computer. Nothing is uploaded to or stored on this website.</p>
      <button class="btn btn-secondary" data-command="open-sample" ${disabled}>Open Sample Project</button>
      <p class="muted small">${support}</p>
    </div>`;
}

function renderHeader() {
  const header = el('div', 'tree-header');
  const name = escapeHtml(state.tree.name);
  header.innerHTML = `
    <span class="tree-header-name" title="${name}">${name}</span>
    <span class="tree-actions">
      <button class="icon-btn" data-action="new-file" title="New File" aria-label="New File">${treeIcons.newFile}</button>
      <button class="icon-btn" data-action="new-folder" title="New Folder" aria-label="New Folder">${treeIcons.newFolder}</button>
      <button class="icon-btn" data-action="refresh" title="Refresh Explorer" aria-label="Refresh Explorer">${treeIcons.refresh}</button>
      <button class="icon-btn" data-action="collapse" title="Collapse Folders" aria-label="Collapse Folders">${treeIcons.collapseAll}</button>
    </span>`;
  header.addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (!button) {
      selectedDir = '';
      selectedPath = '';
      render();
      return;
    }
    switch (button.dataset.action) {
      case 'new-file': startCreate('file'); break;
      case 'new-folder': startCreate('dir'); break;
      case 'refresh': refreshTree(); break;
      case 'collapse': collapseAll(); break;
      default: break;
    }
  });
  return header;
}

function renderTree() {
  const tree = el('div', 'tree');
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', `Files in ${state.tree.name}`);
  const fragment = document.createDocumentFragment();
  renderChildren(state.tree, 0, fragment);
  tree.appendChild(fragment);

  // Exactly one row is in the Tab order: the focused one, or the first row.
  const allRows = [...tree.querySelectorAll('.tree-row[data-path]')];
  const focusRow = allRows.find((r) => r.dataset.path === focusedPath) || allRows[0];
  if (focusRow) {
    focusRow.tabIndex = 0;
    focusedPath = focusRow.dataset.path;
  }

  tree.addEventListener('click', onRowClick);
  tree.addEventListener('keydown', onTreeKeydown);
  tree.addEventListener('contextmenu', onContextMenu);
  return tree;
}

function renderChildren(dirNode, depth, fragment) {
  if (creating && creating.dir === dirNode.path) fragment.appendChild(renderInputRow(depth));
  for (const node of dirNode.children) {
    fragment.appendChild(renderRow(node, depth));
    if (node.kind === 'dir' && expanded.has(node.path)) renderChildren(node, depth + 1, fragment);
  }
}

function renderRow(node, depth) {
  if (renaming && renaming.path === node.path) return renderRenameRow(node, depth);
  const row = el('div', 'tree-row');
  row.dataset.path = node.path;
  row.dataset.kind = node.kind;
  row.tabIndex = -1;
  row.title = node.path;
  row.style.paddingInlineStart = `${8 + depth * 12}px`;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));

  const isDir = node.kind === 'dir';
  const isOpen = isDir && expanded.has(node.path);
  if (isDir) row.setAttribute('aria-expanded', String(isOpen));
  const chevron = isDir ? (isOpen ? icons.chevronDown : icons.chevronRight) : '';
  const icon = isDir ? (isOpen ? icons.folderOpen : icons.folder) : icons.file;
  const colour = isDir ? 'ft-folder' : fileTypeClass(node.name);
  row.innerHTML = `
    <span class="tree-chevron">${chevron}</span>
    <span class="tree-icon ${colour}">${icon}</span>
    <span class="tree-name">${escapeHtml(node.name)}</span>`;

  const isActive = node.path === state.activePath;
  row.setAttribute('aria-selected', String(isActive || node.path === selectedPath));
  if (isActive) row.classList.add('active');
  else if (node.path === selectedPath) row.classList.add('selected');
  return row;
}

function renderInputRow(depth) {
  const row = el('div', 'tree-row');
  row.setAttribute('role', 'none');
  row.style.paddingInlineStart = `${8 + depth * 12}px`;
  const icon = creating.kind === 'dir' ? icons.folder : icons.file;
  row.innerHTML = `<span class="tree-chevron"></span><span class="tree-icon ft-default">${icon}</span>`;

  const input = el('input', 'tree-input');
  input.type = 'text';
  input.spellcheck = false;
  input.setAttribute('aria-label', creating.kind === 'dir' ? 'New folder name' : 'New file name');
  input.placeholder = creating.kind === 'dir' ? 'folder name' : 'file name, e.g. index.html';

  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    const target = creating;
    creating = null;
    if (!commit || !name) {
      render();
      return;
    }
    const problem = fs.validateName(name);
    if (problem) {
      toast(problem, 'error');
      render();
      return;
    }
    try {
      if (target.kind === 'dir') {
        const path = await fs.createDir(target.dir, name);
        expanded.add(path);
        selectedDir = path;
        selectedPath = path;
        focusedPath = path;
        await refreshTree();
      } else {
        const path = await fs.createFile(target.dir, name);
        selectedDir = target.dir;
        selectedPath = path;
        focusedPath = path;
        await refreshTree();
        await openFile(path);
      }
    } catch (err) {
      toast(`Unable to create "${name}": ${err.message}`, 'error');
      render();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(input.value.trim() !== ''));
  row.appendChild(input);
  return row;
}


/* ---------- Renaming, deleting, copying a path ---------- */

function renderRenameRow(node, depth) {
  const row = el('div', 'tree-row');
  row.setAttribute('role', 'none');
  row.style.paddingInlineStart = `${8 + depth * 12}px`;
  const isDir = node.kind === 'dir';
  const icon = isDir ? (expanded.has(node.path) ? icons.folderOpen : icons.folder) : icons.file;
  const colour = isDir ? 'ft-folder' : fileTypeClass(node.name);
  row.innerHTML = `
    <span class="tree-chevron"></span>
    <span class="tree-icon ${colour}">${icon}</span>`;

  const input = el('input', 'tree-input');
  input.type = 'text';
  input.spellcheck = false;
  input.value = renaming.name;
  input.setAttribute('aria-label', `New name for ${node.name}`);

  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    const target = renaming;
    renaming = null;
    if (!commit || !name || name === target.name) {
      render();
      focusPath(target.path);
      return;
    }
    commitRename(target.path, name);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(input.value.trim() !== ''));
  row.appendChild(input);
  return row;
}

/** Folders that were open keep their arrows open under the new name. */
function remapExpanded(oldPath, newPath) {
  for (const path of [...expanded]) {
    if (path !== oldPath && !path.startsWith(oldPath + '/')) continue;
    expanded.delete(path);
    expanded.add(newPath + path.slice(oldPath.length));
  }
}

async function commitRename(path, name) {
  const node = fs.findNode(state.tree, path);
  const problem = fs.validateName(name);
  if (problem) {
    toast(problem, 'error');
    render();
    return;
  }

  const backend = fs.current();
  const target = fs.join(fs.parentOf(path), name);
  if (await fs.exists(target)) {
    toast(`"${name}" already exists in that folder, so nothing was renamed.`, 'error');
    render();
    return;
  }

  // No browser can rename a folder on the disk outright: it has to be copied under the new
  // name and the old one deleted. That is quick for a website and slow for a folder full of
  // libraries, so a big one says so before it starts.
  if (node?.kind === 'dir' && backend.kind === 'native') {
    const count = await backend.countFiles(path, LARGE_FOLDER + 1).catch(() => 0);
    if (count > LARGE_FOLDER) {
      const go = await confirmDialog({
        title: `Rename "${node.name}" to "${name}"?`,
        message: `Your browser cannot rename a folder directly, so all ${count}+ files inside it `
          + 'have to be copied under the new name and the originals then deleted. That can take a while.',
        confirmLabel: 'Rename anyway',
        cancelLabel: 'Cancel',
      });
      if (!go) {
        render();
        return;
      }
    }
  }

  try {
    const newPath = await fs.rename(path, name);
    retargetOpenFiles(path, newPath);
    remapExpanded(path, newPath);
    if (selectedDir === path || selectedDir.startsWith(path + '/')) selectedDir = newPath + selectedDir.slice(path.length);
    selectedPath = newPath;
    await refreshTree();
    focusPath(newPath);

    if (backend.kind === 'native') {
      toast(`Renamed to "${name}".`, 'success', 2000);
    } else {
      markNeedsExport();
      toast(`Renamed to "${name}" in the editor's copy of "${backend.name}". Save Folder writes it out.`, 'info', 4500);
    }
  } catch (err) {
    console.error(err);
    toast(`Unable to rename "${fs.baseName(path)}": ${err.message}`, 'error');
    render();
  }
}

function countFiles(node) {
  if (node.kind === 'file') return 1;
  return node.children.reduce((total, child) => total + countFiles(child), 0);
}

async function requestDelete(path) {
  const node = fs.findNode(state.tree, path);
  if (!node) return;
  const backend = fs.current();
  const isDir = node.kind === 'dir';
  const inside = isDir ? countFiles(node) : 0;
  const what = isDir
    ? `"${node.name}" and the ${inside} file${inside === 1 ? '' : 's'} inside it`
    : `"${node.name}"`;

  const message = backend.kind === 'native'
    ? `${what} will be deleted from "${backend.name}" on your disk. This cannot be undone here — `
      + 'only your own recycle bin or a backup can bring it back.'
    : `${what} will be removed from the editor's copy of "${backend.name}". `
      + (backend.zip
        ? `The zip on your disk keeps it until you use Save Folder.`
        : 'The folder on your disk is not touched — this browser cannot write to it.');

  const go = await confirmDialog({
    title: `Delete ${isDir ? 'folder' : 'file'} "${node.name}"?`,
    message,
    confirmLabel: isDir ? 'Delete folder' : 'Delete file',
    cancelLabel: 'Keep it',
    danger: true,
  });
  if (!go) return;

  try {
    // Delete first, close the tabs second: if the delete fails, unsaved work is still open
    // in a tab rather than thrown away for a file that is still on the disk.
    await fs.remove(path);
    closeFilesUnder(path);
    const parent = fs.parentOf(path);
    selectedPath = parent;
    selectedDir = parent;
    await refreshTree();
    focusPath(parent);
    if (backend.kind === 'native') {
      toast(`Deleted "${node.name}".`, 'success', 2500);
    } else {
      markNeedsExport();
      toast(`Deleted "${node.name}" from the editor's copy of "${backend.name}". Save Folder writes it out.`, 'info', 4500);
    }
  } catch (err) {
    console.error(err);
    toast(`Unable to delete "${node.name}": ${err.message}`, 'error');
    await refreshTree();
  }
}

/**
 * Put a file's path on the clipboard. It is the path *inside* the folder you opened
 * ("css/style.css"): a browser is never told where that folder sits on your disk, so there is
 * no full path to copy.
 */
async function copyPath(path) {
  const done = () => toast(`Copied "${path}" — the path inside "${state.folder.name}".`, 'success', 2500);
  try {
    await navigator.clipboard.writeText(path);
    done();
    return;
  } catch {
    /* no clipboard permission, or an older browser: fall back to the old copy trick */
  }
  const area = el('textarea', 'sr-only');
  area.value = path;
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (copied) done();
  else toast(`This browser would not let the page copy to the clipboard. The path is: ${path}`, 'warning', 6000);
}

function openRowMenu(path, kind, x, y) {
  selectedPath = path;
  focusedPath = path;
  selectedDir = kind === 'dir' ? path : fs.parentOf(path);
  updateActiveRow();
  const row = host.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
  openContextMenu({
    x,
    y,
    returnFocusTo: row,
    items: [
      { label: 'Rename…', hint: 'F2', onClick: () => startRename(path) },
      { label: 'Delete', hint: 'Del', danger: true, onClick: () => requestDelete(path) },
      { separator: true },
      { label: 'Copy Path', onClick: () => copyPath(path) },
    ],
  });
}

/* ---------- Interaction ---------- */

async function activateRow(row) {
  const { path, kind } = row.dataset;
  selectedPath = path;
  focusedPath = path;

  if (kind === 'dir') {
    selectedDir = path;
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    render();
    return;
  }

  selectedDir = fs.parentOf(path);

  // A zip is not something to read in the editor, but it is something to work in: open its
  // contents as the project instead of a tab full of unreadable bytes.
  if (fs.isZipPath(path) && openZip) {
    render();
    await openZip(path);
    return;
  }

  try {
    await openFile(path); // the 'active' event re-renders the tree
  } catch (err) {
    console.error(err);
    toast(`Unable to open ${path}: ${err.message}. Try Refresh Explorer.`, 'error');
    render();
  }
}

function onRowClick(e) {
  const row = e.target.closest('.tree-row[data-path]');
  if (!row) return;
  activateRow(row);
}

function visibleRows() {
  return [...host.querySelectorAll('.tree-row[data-path]')];
}

/** Move the keyboard focus to one path, if a row for it is on screen. */
function focusPath(path) {
  focusedPath = path;
  const rows = visibleRows();
  for (const row of rows) row.tabIndex = row.dataset.path === path ? 0 : -1;
  host.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`)?.focus();
}

function onContextMenu(e) {
  // Only a real right-click opens the menu. A previewed page shares this origin and can
  // already reach the folder directly, so this is consistency with the rest of the app
  // rather than a wall — but Rename and Delete should not be one forged event away.
  if (!e.isTrusted) return;
  const row = e.target.closest('.tree-row[data-path]');
  if (!row) return; // empty space below the tree: leave the browser's own menu alone
  e.preventDefault();
  openRowMenu(row.dataset.path, row.dataset.kind, e.clientX, e.clientY);
}

function focusRowAt(rows, index) {
  const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
  if (!row) return;
  for (const r of rows) r.tabIndex = -1;
  row.tabIndex = 0;
  focusedPath = row.dataset.path;
  row.focus();
}

function onTreeKeydown(e) {
  const rows = visibleRows();
  const current = e.target.closest('.tree-row[data-path]');
  if (!current || !rows.length) return;
  const index = rows.indexOf(current);
  const { path, kind } = current.dataset;

  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusRowAt(rows, index + 1); break;
    case 'ArrowUp': e.preventDefault(); focusRowAt(rows, index - 1); break;
    case 'Home': e.preventDefault(); focusRowAt(rows, 0); break;
    case 'End': e.preventDefault(); focusRowAt(rows, rows.length - 1); break;
    case 'ArrowRight':
      e.preventDefault();
      if (kind === 'dir' && !expanded.has(path)) {
        expanded.add(path);
        selectedDir = path;
        focusedPath = path;
        render();
        host.querySelector('.tree-row[tabindex="0"]')?.focus();
      } else if (kind === 'dir') {
        focusRowAt(rows, index + 1);
      }
      break;
    case 'ArrowLeft': {
      e.preventDefault();
      if (kind === 'dir' && expanded.has(path)) {
        expanded.delete(path);
        focusedPath = path;
        render();
        host.querySelector('.tree-row[tabindex="0"]')?.focus();
      } else {
        const parentPath = fs.parentOf(path);
        const parentIndex = rows.findIndex((r) => r.dataset.path === parentPath);
        if (parentIndex >= 0) focusRowAt(rows, parentIndex);
      }
      break;
    }
    case 'Enter':
    case ' ':
      e.preventDefault();
      activateRow(current);
      break;
    case 'F2':
      if (!e.isTrusted) break; // as in onContextMenu: a real key press, not a staged one
      e.preventDefault();
      startRename(path);
      break;
    case 'Delete':
      if (!e.isTrusted) break;
      e.preventDefault();
      requestDelete(path);
      break;
    case 'ContextMenu': {
      e.preventDefault();
      // Open it at the row itself, since there is no pointer to open it at.
      const box = current.getBoundingClientRect();
      openRowMenu(path, kind, box.left + 16, box.bottom);
      break;
    }
    case 'F10':
      if (!e.shiftKey) break;
      e.preventDefault();
      openRowMenu(path, kind, current.getBoundingClientRect().left + 16, current.getBoundingClientRect().bottom);
      break;
    default:
      break;
  }
}

// js/explorer.js — the file tree in the sidebar: folders you can expand, files you can
// click to open, and the "new file / new folder" inline inputs.
// Keyboard: Up/Down move, Right expands, Left collapses (or goes to the parent), Enter opens.

import { state, on, emit } from './state.js';
import * as fs from './fs/index.js';
import { openFile } from './editor.js';
import { icons, fileTypeClass } from './icons.js';
import { escapeHtml, el } from './dom.js';
import { toast } from './toast.js';

const expanded = new Set(['']); // paths of folders that are open ('' is the root)
let host = null;
let selectedPath = '';           // the last row you clicked
let selectedDir = '';            // where a new file or folder will be created
let focusedPath = null;          // the row that receives keyboard focus (roving tabindex)
let creating = null;             // { kind: 'file' | 'dir', dir } while the inline input is shown

export function initExplorer(container) {
  host = container;
  on('folder', render);
  on('tree', render);
  on('active', render);
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

function renderTitle() {
  return el('h2', 'sidebar-title', 'Explorer');
}

function renderEmpty() {
  const support = fs.supportsNative
    ? 'Your browser can save changes straight back to the folder on your disk.'
    : 'This browser cannot write to your disk (Chrome, Edge or Opera can). Files open read-only and Ctrl+S downloads the edited file instead.';
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
      <button class="icon-btn" data-action="new-file" title="New File" aria-label="New File">${icons.newFile}</button>
      <button class="icon-btn" data-action="new-folder" title="New Folder" aria-label="New Folder">${icons.newFolder}</button>
      <button class="icon-btn" data-action="refresh" title="Refresh Explorer" aria-label="Refresh Explorer">${icons.refresh}</button>
      <button class="icon-btn" data-action="collapse" title="Collapse Folders" aria-label="Collapse Folders">${icons.collapseAll}</button>
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
    default:
      break;
  }
}

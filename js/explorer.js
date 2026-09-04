// js/explorer.js — the file tree in the sidebar: folders you can expand, files you can
// click to open, and the "new file / new folder" inline inputs.

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
let creating = null;             // { kind: 'file' | 'dir', dir } while the inline input is shown

export function initExplorer(container) {
  host = container;
  on('folder', render);
  on('tree', render);
  on('active', render);
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
    toast(`Could not read the folder: ${err.message}`, 'error');
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
  creating = null;
}

/* ---------- Rendering ---------- */

function render() {
  if (!host) return;
  host.innerHTML = '';
  if (!fs.hasFolder() || !state.tree) {
    renderEmpty();
    return;
  }
  host.append(renderTitle(), renderHeader(), renderTree());
}

function renderTitle() {
  return el('div', 'sidebar-title', 'Explorer');
}

function renderEmpty() {
  const support = fs.supportsNative
    ? 'Your browser can save changes straight back to the folder on your disk.'
    : 'This browser cannot write to your disk (Chrome, Edge or Opera can). Files open read-only and Ctrl+S downloads the edited file instead.';
  host.innerHTML = `
    <div class="sidebar-title">Explorer</div>
    <div class="explorer-empty">
      <p>You have not opened a folder yet.</p>
      <button class="btn" data-command="open-folder">Open Folder</button>
      <p class="muted small">Your files stay on your computer. Nothing is uploaded to or stored on this website.</p>
      <button class="btn btn-secondary" data-command="open-sample">Open Sample Project</button>
      <p class="muted small">${support}</p>
    </div>`;
}

function renderHeader() {
  const header = el('div', 'tree-header');
  const name = escapeHtml(state.tree.name);
  header.innerHTML = `
    <span class="tree-header-name" title="${name}">${name}</span>
    <span class="tree-actions">
      <button class="icon-btn" data-action="new-file" title="New File">${icons.newFile}</button>
      <button class="icon-btn" data-action="new-folder" title="New Folder">${icons.newFolder}</button>
      <button class="icon-btn" data-action="refresh" title="Refresh Explorer">${icons.refresh}</button>
      <button class="icon-btn" data-action="collapse" title="Collapse Folders">${icons.collapseAll}</button>
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
    }
  });
  return header;
}

function renderTree() {
  const tree = el('div', 'tree');
  tree.tabIndex = 0;
  const fragment = document.createDocumentFragment();
  renderChildren(state.tree, 0, fragment);
  tree.appendChild(fragment);
  tree.addEventListener('click', onRowClick);
  tree.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('tree-row')) onRowClick(e);
  });
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
  row.style.paddingLeft = `${8 + depth * 12}px`;

  const isDir = node.kind === 'dir';
  const isOpen = isDir && expanded.has(node.path);
  const chevron = isDir ? (isOpen ? icons.chevronDown : icons.chevronRight) : '';
  const icon = isDir ? (isOpen ? icons.folderOpen : icons.folder) : icons.file;
  const colour = isDir ? 'ft-folder' : fileTypeClass(node.name);
  row.innerHTML = `
    <span class="tree-chevron">${chevron}</span>
    <span class="tree-icon ${colour}">${icon}</span>
    <span class="tree-name">${escapeHtml(node.name)}</span>`;

  if (node.path === state.activePath) row.classList.add('active');
  else if (node.path === selectedPath) row.classList.add('selected');
  return row;
}

function renderInputRow(depth) {
  const row = el('div', 'tree-row');
  row.style.paddingLeft = `${8 + depth * 12}px`;
  const icon = creating.kind === 'dir' ? icons.folder : icons.file;
  row.innerHTML = `<span class="tree-chevron"></span><span class="tree-icon ft-default">${icon}</span>`;

  const input = el('input', 'tree-input');
  input.type = 'text';
  input.spellcheck = false;
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
        await refreshTree();
      } else {
        const path = await fs.createFile(target.dir, name);
        selectedDir = target.dir;
        selectedPath = path;
        await refreshTree();
        await openFile(path);
      }
    } catch (err) {
      toast(`Could not create "${name}": ${err.message}`, 'error');
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

async function onRowClick(e) {
  const row = e.target.closest('.tree-row');
  if (!row || row.dataset.path === undefined) return;
  const { path, kind } = row.dataset;
  selectedPath = path;

  if (kind === 'dir') {
    selectedDir = path;
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    render();
    return;
  }

  selectedDir = fs.parentOf(path);
  try {
    await openFile(path);
  } catch (err) {
    console.error(err);
    toast(`Could not open ${path}: ${err.message}`, 'error');
  }
  render();
}

// js/main.js — starts the app and wires the pieces together: buttons, menus, keyboard
// shortcuts and the two big flows (open a folder, close a folder).

import { CONFIG } from './config.js';
import { state, on, emit, activeFile, hasDirtyFiles } from './state.js';
import { renderIcons } from './icons.js';
import { toast } from './toast.js';
import * as fs from './fs/index.js';
import {
  initEditor, openFile, saveFile, saveAll, closeAllFiles, errorPlaceholder, getEditor, getMonaco,
} from './editor.js';
import { initTabs } from './tabs.js';
import { initExplorer, refreshTree, startCreate, resetExplorer } from './explorer.js';
import { initScratch, enterScratchMode, leaveScratchMode } from './scratch.js';
import { loadSettings, renderSettings, applySettings } from './settings.js';
import { initLayout, showSidebarView, toggleSidebar, togglePanel, togglePreview } from './layout.js';
import { initPanel } from './panel.js';
import { initStatusBar } from './statusbar.js';

const $ = (id) => document.getElementById(id);

async function boot() {
  renderIcons();
  loadSettings();
  initLayout();
  initPanel();
  initStatusBar();
  initTabs($('tabs'));
  initExplorer($('view-explorer'));
  renderSettings($('view-settings'));
  initScratch($('language-select'));
  wireTitleBar();
  wireCommands();
  wireShortcuts();
  on('active', updateTitle);
  on('tabs', updateTitle);
  on('folder', updateTitle);
  updateTitle();

  try {
    await initEditor($('editor'), $('editor-placeholder'));
  } catch (err) {
    console.error(err);
    errorPlaceholder(
      `The code editor could not be downloaded from ${CONFIG.monacoBase}. ` +
      'Check your internet connection and reload the page.',
    );
    return;
  }

  applySettings();
  emit('settings', state.settings);
  setMode('scratch');
  enterScratchMode();
}

/* ---------- Modes ---------- */

function setMode(mode) {
  state.mode = mode;
  const app = $('app');
  app.classList.toggle('mode-scratch', mode === 'scratch');
  app.classList.toggle('mode-folder', mode === 'folder');
  $('menu-close-folder').disabled = mode !== 'folder';
  emit('mode', mode);
}

function updateTitle() {
  const file = activeFile();
  const parts = [];
  if (file) parts.push((file.dirty ? '● ' : '') + file.name);
  if (state.folder) parts.push(state.folder.name);
  parts.push(CONFIG.appName);
  const title = parts.join(' — ');
  $('titlebar-title').textContent = title;
  document.title = title;
}

/* ---------- Folder flows ---------- */

async function openFolderFlow(source) {
  let backend;
  try {
    backend = source === 'sample' ? fs.sampleFolder() : await fs.pickFolder();
  } catch (err) {
    reportError(err);
    return;
  }
  if (!backend) return; // the user cancelled the picker

  if (state.mode === 'folder' && hasDirtyFiles()) {
    const discard = window.confirm('You have unsaved changes in the current folder. Discard them and open the new folder?');
    if (!discard) return;
  }

  if (state.mode === 'folder') closeAllFiles();
  else leaveScratchMode();

  fs.setCurrent(backend);
  resetExplorer();
  state.folder = { name: backend.name, kind: backend.kind, readOnly: backend.readOnly, sample: backend.sample };
  setMode('folder');
  emit('folder', state.folder);
  await refreshTree();
  showSidebarView('explorer');

  // A website usually starts at index.html, so open it right away when it exists.
  if (fs.findNode(state.tree, 'index.html')) {
    try {
      await openFile('index.html');
    } catch (err) {
      reportError(err);
    }
  }

  if (backend.sample) toast('Sample project opened. It lives in memory only: refreshing the page resets it.', 'info', 4500);
  else if (backend.readOnly) toast(`Opened "${backend.name}" read-only. Ctrl+S downloads the edited file.`, 'warning', 5000);
  else toast(`Opened "${backend.name}". Ctrl+S saves straight to your disk.`, 'success');
}

async function closeFolderFlow() {
  if (state.mode !== 'folder') return;
  if (hasDirtyFiles() && !window.confirm('You have unsaved changes. Close the folder anyway?')) return;
  closeAllFiles();
  fs.closeFolder();
  resetExplorer();
  state.folder = null;
  state.tree = null;
  emit('folder', null);
  emit('tree');
  setMode('scratch');
  enterScratchMode();
}

/* ---------- Commands (buttons, menus and shortcuts all go through here) ---------- */

const commands = {
  'open-folder': () => openFolderFlow('pick'),
  'open-sample': () => openFolderFlow('sample'),
  'close-folder': () => closeFolderFlow(),
  'save': () => {
    const file = activeFile();
    return file ? saveFile(file.path) : undefined;
  },
  'save-all': () => saveAll(),
  'new-file': () => startCreate('file'),
  'new-folder': () => startCreate('dir'),
  'toggle-sidebar': () => toggleSidebar(),
  'toggle-panel': () => togglePanel(),
  'toggle-preview': () => togglePreview(),
  'explorer': () => showSidebarView('explorer'),
  'settings': () => showSidebarView('settings'),
};

export function runCommand(id) {
  const command = commands[id];
  if (!command) {
    console.warn('Unknown command:', id);
    return;
  }
  try {
    // Run synchronously so browser dialogs (folder picker) still count as a user click.
    const result = command();
    if (result && typeof result.catch === 'function') result.catch(reportError);
  } catch (err) {
    reportError(err);
  }
}

function reportError(err) {
  console.error(err);
  toast(err?.message || String(err), 'error', 5000);
}

function wireCommands() {
  document.addEventListener('click', (e) => {
    const button = e.target.closest('[data-command]');
    if (!button || button.disabled) return;
    closeOpenMenu();
    runCommand(button.dataset.command);
  });
  on('command', runCommand);
}

/* ---------- Title bar ---------- */

function closeOpenMenu() {
  $('open-menu-list').hidden = true;
}

function wireTitleBar() {
  $('btn-open-folder').addEventListener('click', () => runCommand('open-folder'));
  $('btn-open-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    const list = $('open-menu-list');
    list.hidden = !list.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#open-menu')) closeOpenMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOpenMenu();
  });

  $('btn-toggle-preview').addEventListener('click', () => togglePreview());
  $('btn-preview-close').addEventListener('click', () => togglePreview(false));
  $('btn-toggle-panel').addEventListener('click', () => togglePanel());
  $('btn-settings').addEventListener('click', () => showSidebarView('settings'));
}

/* ---------- Keyboard shortcuts ---------- */

function wireShortcuts() {
  // Capture phase: we see the key before Monaco or the browser does.
  window.addEventListener(
    'keydown',
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 's' && !e.shiftKey) { e.preventDefault(); runCommand('save'); }
      else if (key === 's' && e.shiftKey) { e.preventDefault(); runCommand('save-all'); }
      else if (key === 'b' && !e.shiftKey) { e.preventDefault(); runCommand('toggle-sidebar'); }
      else if (key === 'j' && !e.shiftKey) { e.preventDefault(); runCommand('toggle-panel'); }
      else if (key === 'e' && e.shiftKey) { e.preventDefault(); runCommand('explorer'); }
      else if (key === ',') { e.preventDefault(); runCommand('settings'); }
    },
    true,
  );

  // Warn before leaving the page with unsaved files (browsers show their own dialog).
  window.addEventListener('beforeunload', (e) => {
    if (hasDirtyFiles()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// Handy for debugging in the browser console and for the automated tests.
window.SVS = { state, fs, getEditor, getMonaco, runCommand };

boot().catch((err) => {
  console.error(err);
  errorPlaceholder(err?.message || String(err));
});

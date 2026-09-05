// js/main.js — starts the app and wires the pieces together: buttons, menus, keyboard
// shortcuts and the two big flows (open a folder, close a folder).

import { CONFIG } from './config.js';
import { state, on, emit, activeFile, hasDirtyFiles } from './state.js';
import { renderIcons } from './icons.js';
import { toast } from './toast.js';
import { confirmDialog } from './dialog.js';
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
import { initLive, toggle as toggleLive, stop as stopLive } from './live.js';
import { $ } from './dom.js';

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
  await initLive();
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

  // Folders and the live server need the editor, so their buttons wake up only now.
  $('btn-open-folder').disabled = false;
  $('btn-live').disabled = false;

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
  const titleEl = $('titlebar-title');
  titleEl.textContent = title;
  titleEl.title = title; // the full text, in case it is cut short
  document.title = title;
}

/* ---------- Folder flows ---------- */

async function openFolderFlow(source) {
  if (!state.editorReady) {
    toast('The editor is still loading. Try again in a moment.', 'warning');
    return;
  }

  let backend;
  try {
    backend = source === 'sample' ? fs.sampleFolder() : await fs.pickFolder();
  } catch (err) {
    reportError(err);
    return;
  }
  if (!backend) return; // the user cancelled the picker

  if (state.mode === 'folder' && hasDirtyFiles()) {
    const discard = await confirmDialog({
      title: 'Discard unsaved changes?',
      message: `Some files in "${state.folder.name}" have unsaved changes. Opening "${backend.name}" will lose them.`,
      confirmLabel: 'Discard changes and open',
      cancelLabel: 'Keep editing',
      danger: true,
    });
    if (!discard) return;
  }

  if (state.mode === 'folder') closeAllFiles();
  else leaveScratchMode();

  fs.setCurrent(backend);
  resetExplorer();
  state.tree = null; // the explorer shows "Loading…" until the folder has been read
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
  if (hasDirtyFiles()) {
    const discard = await confirmDialog({
      title: 'Close folder without saving?',
      message: 'Some files have unsaved changes. They will be lost when the folder is closed.',
      confirmLabel: 'Close without saving',
      cancelLabel: 'Keep editing',
      danger: true,
    });
    if (!discard) return;
  }
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
  'toggle-live': () => toggleLive(),
  'stop-live': () => stopLive(),
  'explorer': () => showSidebarView('explorer'),
  'settings': () => showSidebarView('settings'),
  'run': () => toast('Running programs arrives in Phase 3.', 'info'),
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
  toast(err?.message || String(err), 'error');
}

function wireCommands() {
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return; // only real clicks may run commands (a previewed page could forge events)
    const button = e.target.closest('[data-command]');
    if (!button || button.disabled) return;
    closeOpenMenu();
    runCommand(button.dataset.command);
  });
  on('command', runCommand);
}

/* ---------- Title bar ---------- */

function setMenuOpen(open) {
  $('open-menu-list').hidden = !open;
  $('btn-open-menu').setAttribute('aria-expanded', String(open));
  if (open) $('open-menu-list').querySelector('button:not(:disabled)')?.focus();
}

function closeOpenMenu() {
  if (!$('open-menu-list').hidden) setMenuOpen(false);
}

function wireTitleBar() {
  $('btn-open-folder').addEventListener('click', () => runCommand('open-folder'));
  $('btn-open-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    setMenuOpen($('open-menu-list').hidden);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#open-menu')) closeOpenMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('open-menu-list').hidden) {
      closeOpenMenu();
      $('btn-open-menu').focus();
    }
  });

  $('btn-run').addEventListener('click', () => runCommand('run'));
  $('btn-toggle-preview').addEventListener('click', () => togglePreview());
  $('btn-preview-close').addEventListener('click', () => togglePreview(false));
  $('btn-toggle-panel').addEventListener('click', () => togglePanel());
  $('btn-settings').addEventListener('click', () => showSidebarView('settings'));

  $('skip-link').addEventListener('click', (e) => {
    e.preventDefault();
    const editor = getEditor();
    if (editor && editor.getModel()) editor.focus();
    else $('editor-area').focus();
  });
}

/* ---------- Keyboard shortcuts ---------- */

function wireShortcuts() {
  // Capture phase: we see the key before Monaco or the browser does.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return; // ignore synthetic key events (they could come from a previewed page)
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

  // Monaco cancels its own background requests (word highlights, hovers) when you switch
  // files, and reports each cancellation as an unhandled "Canceled" rejection. VS Code filters
  // these out too; they are not errors. Anything else still reaches the console.
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    if (reason && (reason.name === 'Canceled' || reason.message === 'Canceled')) e.preventDefault();
  });

  // Warn before leaving the page with unsaved files (browsers show their own dialog).
  window.addEventListener('beforeunload', (e) => {
    if (hasDirtyFiles()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// Debug hook for the browser console and the automated tests. It is only exposed on request
// (`?debug` in the address, or window.SVS_DEBUG), because a previewed page shares this origin
// and must not get a ready-made handle to the file system.
if (window.SVS_DEBUG || new URLSearchParams(location.search).has('debug')) {
  window.SVS = { state, fs, getEditor, getMonaco, runCommand };
}

boot().catch((err) => {
  console.error(err);
  errorPlaceholder(err?.message || String(err));
});

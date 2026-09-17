// js/main.js — starts the app and wires the pieces together: buttons, menus, keyboard
// shortcuts and the two big flows (open a folder, close a folder).

import { CONFIG } from './config.js';
import { state, on, emit, activeFile, hasDirtyFiles } from './state.js';
import { renderIcons } from './icons.js';
import { toast } from './toast.js';
import { confirmDialog, promptDialog } from './dialog.js';
import * as fs from './fs/index.js';
import {
  initEditor, openFile, activateFile, saveFile, saveAll, closeAllFiles, errorPlaceholder,
  getEditor, getMonaco,
} from './editor.js';
import { initTabs } from './tabs.js';
import { initExplorer, refreshTree, startCreate, resetExplorer } from './explorer.js';
import { initScratch, enterScratchMode, leaveScratchMode } from './scratch.js';
import { loadSettings, renderSettings, applySettings } from './settings.js';
import { initLayout, showSidebarView, toggleSidebar, togglePanel, togglePreview } from './layout.js';
import { initPanel } from './panel.js';
import { initStatusBar } from './statusbar.js';
import { initLive, toggle as toggleLive, stop as stopLive } from './live.js';
import { initRunner, run as runProgram } from './runner.js';
import { initRecent, rememberFolder, offerReopen, reopenNow } from './recent.js';
import { initSaving, saveScratch, saveScratchAs, saveFolderZip, supportsSaveAs } from './saving.js';
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
  initRunner();

  applySettings();
  emit('settings', state.settings);

  // Load what was remembered from last time before the scratch file is created, so the tab
  // can show the name of the file it belongs to rather than "untitled".
  await initSaving();
  await initRecent({ reopen: (backend, restore) => adoptFolder(backend, restore) });

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
  $('menu-save-folder').hidden = mode !== 'folder';
  $('menu-save-as').hidden = mode !== 'scratch' || !supportsSaveAs;
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

  if (fs.isEmptyPick(backend)) {
    backend = await startEmptyFolder();
    if (!backend) return;
  }

  await adoptFolder(backend);
}

/**
 * Firefox and Safari read a folder by listing the files in it, so an empty folder gives them
 * nothing at all — not even its name. Rather than looking like the picker was cancelled, offer
 * to start a folder here: you name it, you make the files, and Save Folder hands it back as a
 * zip you can unzip wherever you want it.
 */
async function startEmptyFolder() {
  const name = await promptDialog({
    title: 'That folder is empty',
    message: 'This browser can only see a folder through the files inside it, so an empty one is '
      + 'invisible to it — even its name. You can start a folder here instead: make your files, '
      + 'then Save Folder downloads them as a zip to unzip wherever you like.',
    label: 'Folder name',
    value: 'my-project',
    placeholder: 'my-project',
    confirmLabel: 'Start this folder',
    cancelLabel: 'Cancel',
    validate: (value) => fs.validateName(value),
  });
  return name ? fs.newFolder(name) : null;
}

/**
 * Make `backend` the folder the app is working in.
 * `restore` reopens the tabs a remembered folder had last time, each on the line it was left on.
 */
async function adoptFolder(backend, restore = null) {
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
  state.folder = {
    name: backend.name,
    kind: backend.kind,
    readOnly: backend.readOnly,
    sample: backend.sample,
    needsExport: false, // set once an edit is saved somewhere the disk cannot see
  };
  setMode('folder');
  emit('folder', state.folder);
  await refreshTree();
  showSidebarView('explorer');

  // Remember it (a real folder only) so it can be reopened on your next visit.
  rememberFolder(backend);

  if (restore) {
    const { opened, missing } = await restoreTabs(restore);
    toast(
      `Reopened "${backend.name}"` +
      (opened ? ` with ${opened} file${opened === 1 ? '' : 's'} back where you left off.` : '. Ctrl+S saves straight back into it.') +
      (missing ? ` ${missing} file${missing === 1 ? ' is' : 's are'} no longer there.` : ''),
      missing ? 'warning' : 'success',
      missing ? 6000 : 4000,
    );
    return;
  }

  // A website usually starts at index.html, so open it right away when it exists.
  if (fs.findNode(state.tree, 'index.html')) {
    try {
      await openFile('index.html');
    } catch (err) {
      reportError(err);
    }
  }

  // An empty folder has no file to click, so say where the first one comes from.
  const empty = !state.tree?.children?.length;
  const firstStep = empty ? ' It is empty — make your first file in the Explorer.' : '';
  if (backend.sample) {
    toast('Sample project opened. It lives in memory only: refreshing the page resets it.', 'info', 4500);
  } else if (backend.readOnly) {
    toast(`Opened "${backend.name}" read-only. This browser cannot write to it, so Save Folder packs your edits back up as a zip.`, 'warning', 6000);
  } else if (backend.kind !== 'native') {
    toast(`Started "${backend.name}" in the editor.${firstStep} Nothing is on your disk yet: Save Folder downloads it as a zip.`, 'info', 7000);
  } else {
    toast(`Opened "${backend.name}".${firstStep || ' Ctrl+S saves straight back into it.'}`, 'success', empty ? 5000 : 3000);
  }
}

/** Put back the tabs a folder had open last time. Files that have since gone are counted. */
async function restoreTabs({ tabs = [], activePath = null }) {
  let opened = 0;
  let missing = 0;
  for (const tab of tabs) {
    if (!fs.findNode(state.tree, tab.path)) {
      missing++;
      continue;
    }
    try {
      await openFile(tab.path, {
        activate: false,
        position: { lineNumber: tab.lineNumber || 1, column: tab.column || 1 },
      });
      opened++;
    } catch {
      missing++; // unreadable now (permissions, or replaced by a folder)
    }
  }
  const active = state.openFiles.some((f) => f.path === activePath) ? activePath : state.openFiles[0]?.path;
  if (active) activateFile(active);
  return { opened, missing };
}

async function closeFolderFlow() {
  if (state.mode !== 'folder') return;
  if (hasDirtyFiles() || state.folder.needsExport) {
    const unsaved = hasDirtyFiles();
    const discard = await confirmDialog({
      title: 'Close folder without saving?',
      message: unsaved
        ? 'Some files have unsaved changes. They will be lost when the folder is closed.'
        : `Edits to "${state.folder.name}" are only in the editor — this browser cannot write to the folder itself. ` +
          'Closing it now loses them. Save Folder downloads them as a zip first.',
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
  offerReopen(); // the bar comes back, so the folder is one click away again
}

/* ---------- Commands (buttons, menus and shortcuts all go through here) ---------- */

const commands = {
  'open-folder': () => openFolderFlow('pick'),
  'open-sample': () => openFolderFlow('sample'),
  'close-folder': () => closeFolderFlow(),
  'reopen-folder': () => reopenNow(),
  'save': () => {
    const file = activeFile();
    if (!file) return undefined;
    // The scratch file belongs to no folder, so it asks where to go the first time.
    return file.scratch ? saveScratch() : saveFile(file.path);
  },
  // Nothing to "save all" in scratch mode, so the same keys offer the file a new home instead.
  'save-all': () => (state.mode === 'scratch' ? saveScratchAs() : saveAll()),
  'save-as': () => saveScratchAs(),
  'save-folder': () => saveFolderZip(),
  'new-file': () => startCreate('file'),
  'new-folder': () => startCreate('dir'),
  'toggle-sidebar': () => toggleSidebar(),
  'toggle-panel': () => togglePanel(),
  'toggle-preview': () => togglePreview(),
  'toggle-live': () => toggleLive(),
  'stop-live': () => stopLive(),
  'explorer': () => showSidebarView('explorer'),
  'settings': () => showSidebarView('settings'),
  'run': () => runProgram(),
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
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runCommand('run'); }
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

  // Warn before leaving the page with work that is not on the disk: unsaved tabs, or a folder
  // this browser can only give back as a zip.
  window.addEventListener('beforeunload', (e) => {
    if (hasDirtyFiles() || state.folder?.needsExport) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// Debug hook for the browser console and the automated tests. It is only exposed on request
// (`?debug` in the address, or window.SVS_DEBUG), because a previewed page shares this origin
// and must not get a ready-made handle to the file system.
if (window.SVS_DEBUG || new URLSearchParams(location.search).has('debug')) {
  // adoptFolder is here so the tests can exercise reopening a folder and putting its tabs
  // back without driving the browser's folder picker, which no test can click.
  window.SVS = { state, fs, getEditor, getMonaco, runCommand, adoptFolder };
}

boot().catch((err) => {
  console.error(err);
  errorPlaceholder(err?.message || String(err));
});

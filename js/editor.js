// js/editor.js — loads Monaco (the editor inside VS Code) and manages the open files:
// one Monaco "model" per open file, the active tab, dirty flags and saving.

import { CONFIG } from './config.js';
import { state, emit, on } from './state.js';
import * as fs from './fs/index.js';
import { fontById } from './fonts.js';
import { toast } from './toast.js';
import { icons } from './icons.js';
import { escapeHtml } from './dom.js';
import { confirmDialog } from './dialog.js';

/** The pseudo-path of the scratch file (it does not exist on disk). */
export const SCRATCH_PATH = '__scratch__';

let monaco = null;
let editor = null;
let placeholderEl = null;
const pendingOpens = new Map(); // path -> Promise, so a double-click cannot open a file twice

export function getMonaco() {
  return monaco;
}

export function getEditor() {
  return editor;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

/** Download Monaco from the CDN (or the local copy used by the tests). */
export async function loadMonaco() {
  if (monaco) return monaco;
  const base = CONFIG.monacoBase;

  // Monaco runs its language services (syntax checking, IntelliSense) in Web Workers.
  // A worker script must come from our own origin, so we hand the browser a tiny blob
  // script that immediately imports the real worker from the CDN.
  window.MonacoEnvironment = {
    getWorkerUrl() {
      const code =
        `self.MonacoEnvironment = { baseUrl: '${base}/' };\n` +
        `importScripts('${base}/vs/base/worker/workerMain.js');`;
      return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    },
  };

  await loadScript(`${base}/vs/loader.js`);
  window.require.config({ paths: { vs: `${base}/vs` } });
  monaco = await new Promise((resolve, reject) => {
    window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
  });
  return monaco;
}

/** Create the editor inside `editorEl`. `placeholder` is shown when no text file is active. */
export async function initEditor(editorEl, placeholder) {
  placeholderEl = placeholder;
  await loadMonaco();

  const s = state.settings;
  const font = fontById(s.fontFamily);
  editor = monaco.editor.create(editorEl, {
    model: null,
    theme: 'vs-dark',
    automaticLayout: true, // re-measure when the panes are resized
    fontSize: s.fontSize,
    fontFamily: font.family,
    fontLigatures: font.ligatures,
    wordWrap: s.wordWrap ? 'on' : 'off',
    minimap: { enabled: s.minimap },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    padding: { top: 8 },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    mouseWheelZoom: true,
    ariaLabel: 'Code editor',
  });

  editor.onDidChangeCursorPosition((e) => emit('cursor', e.position));
  // The placeholder describes the open folder, so it has to be redrawn when that changes —
  // an empty folder says something quite different from one with files in it.
  on('tree', refreshPlaceholder);
  on('folder', refreshPlaceholder);
  showPlaceholder(emptyPlaceholder());
  state.editorReady = true;
  emit('editor-ready', { monaco, editor });
  return editor;
}

export function updateEditorOptions(options) {
  if (editor) editor.updateOptions(options);
}

/** Tab size lives on the model (the text), not on the editor widget. */
function applyModelOptions(model) {
  model.updateOptions({ tabSize: state.settings.tabSize, insertSpaces: true });
}

export function applyModelOptionsToAll() {
  for (const f of state.openFiles) if (f.model) applyModelOptions(f.model);
}

/* ---------- Placeholder (what you see when no text file is active) ---------- */

export function showPlaceholder(html) {
  placeholderEl.innerHTML = html;
  placeholderEl.hidden = false;
}

function hidePlaceholder() {
  placeholderEl.hidden = true;
}

/** Redraw the placeholder when the folder behind it changed, unless a file is on screen. */
function refreshPlaceholder() {
  if (!placeholderEl || state.activePath) return;
  showPlaceholder(emptyPlaceholder());
}

const SHORTCUTS_HTML = `
      <div class="shortcuts">
        <span>Save file</span><span><kbd>Ctrl</kbd> + <kbd>S</kbd></span>
        <span>Toggle sidebar</span><span><kbd>Ctrl</kbd> + <kbd>B</kbd></span>
        <span>Toggle bottom panel</span><span><kbd>Ctrl</kbd> + <kbd>J</kbd></span>
        <span>Settings</span><span><kbd>Ctrl</kbd> + <kbd>,</kbd></span>
      </div>`;

/** True when the open folder holds no file anywhere — empty subfolders do not count. */
function folderHasNoFiles() {
  if (!state.tree) return false;
  const anyFile = (node) => (node.kind === 'file' ? true : (node.children || []).some(anyFile));
  return !anyFile(state.tree);
}

function emptyPlaceholder() {
  // "Open a file from the Explorer" is no help when the Explorer has none to open.
  if (state.folder && folderHasNoFiles()) return startHerePlaceholder();
  return `
    <div class="placeholder-content">
      <div class="placeholder-logo">${icons.logo}</div>
      <h2>${escapeHtml(CONFIG.appName)}</h2>
      <p>Open a file from the Explorer to start editing.</p>${SHORTCUTS_HTML}
    </div>`;
}

/** What an empty folder shows: no files to list, so offer the way to make one. */
function startHerePlaceholder() {
  const onDisk = state.folder.kind === 'native';
  const name = escapeHtml(state.folder.name);
  // Folders but no files is not the same as nothing at all, and the Explorer shows the
  // difference, so the heading should not contradict it.
  const bare = !state.tree || !state.tree.children.length;
  return `
    <div class="placeholder-content">
      <div class="placeholder-logo">${icons.newFile}</div>
      <h2>${bare ? `${name} is empty` : `No files in ${name} yet`}</h2>
      <p>${onDisk
        ? 'Make the first file and it is written straight into that folder on your disk.'
        : 'Make the first file here. It stays in the editor, and Save Folder downloads the whole folder as a zip.'}</p>
      <div class="placeholder-actions">
        <button class="btn" data-command="new-file">New File</button>
        <button class="btn btn-secondary" data-command="new-folder">New Folder</button>
      </div>${SHORTCUTS_HTML}
    </div>`;
}

function binaryPlaceholder(entry) {
  return `
    <div class="placeholder-content">
      <div class="placeholder-logo">${icons.file}</div>
      <h2>${escapeHtml(entry.name)}</h2>
      <p>This is a binary file (image, font, archive…), so it cannot be edited as text.</p>
      <p class="muted small">An image preview arrives in Phase 4.</p>
    </div>`;
}

export function errorPlaceholder(message) {
  showPlaceholder(`
    <div class="placeholder-content error">
      <div class="placeholder-logo">${icons.error}</div>
      <h2>The editor could not start</h2>
      <p>${escapeHtml(message)}</p>
    </div>`);
}

/* ---------- Open files ---------- */

function findEntry(path) {
  return state.openFiles.find((f) => f.path === path) || null;
}

/** React to typing: update the dirty flag and tell the rest of the app. */
function watchModel(entry) {
  entry.model.onDidChangeContent(() => {
    if (!entry.scratch) {
      // Comparing version ids means "undo back to the saved text" clears the dot again.
      const dirty = entry.model.getAlternativeVersionId() !== entry.savedVersion;
      if (dirty !== entry.dirty) {
        entry.dirty = dirty;
        emit('tabs');
      }
    }
    emit('content', entry);
  });
}

/**
 * Open a file from the current folder in a tab (reads it from disk the first time).
 * `position` puts the cursor somewhere other than the start — that is how a reopened
 * folder puts you back on the line you were last looking at.
 */
export function openFile(path, { activate = true, position = null } = {}) {
  const existing = findEntry(path);
  if (existing) {
    if (activate) activateFile(path);
    emit('tabs');
    return Promise.resolve(existing);
  }
  if (pendingOpens.has(path)) return pendingOpens.get(path);

  const promise = (async () => {
    const name = fs.baseName(path);
    let entry;
    if (fs.isBinaryPath(path)) {
      entry = { path, name, kind: 'binary', dirty: false };
    } else {
      const text = await fs.readText(path);
      const uri = monaco.Uri.file('/' + path);
      monaco.editor.getModel(uri)?.dispose(); // never two models for one file
      const model = monaco.editor.createModel(text, undefined, uri);
      applyModelOptions(model);
      entry = {
        path,
        name,
        kind: 'text',
        model,
        dirty: false,
        savedVersion: model.getAlternativeVersionId(),
        viewState: null,
        pendingPosition: position,
      };
      watchModel(entry);
    }
    state.openFiles.push(entry);
    if (activate) activateFile(path);
    emit('tabs');
    return entry;
  })();

  pendingOpens.set(path, promise);
  promise.finally(() => pendingOpens.delete(path));
  return promise;
}

/**
 * The text of a file as it is right now in the editor, or null when it is not open.
 * The live server and the runner both use this so they see your unsaved edits.
 */
export function openTextOf(path) {
  const entry = findEntry(path);
  return entry && entry.model && !entry.model.isDisposed() ? entry.model.getValue() : null;
}

/** Show an already-open file in the editor. */
export function activateFile(path) {
  const entry = findEntry(path);
  if (!entry) return;

  // Remember scroll position and cursor of the tab we are leaving.
  const previous = findEntry(state.activePath);
  if (previous && previous.model && editor.getModel() === previous.model) {
    previous.viewState = editor.saveViewState();
  }

  state.activePath = path;
  if (entry.kind === 'text') {
    editor.setModel(entry.model);
    if (entry.viewState) {
      editor.restoreViewState(entry.viewState);
    } else if (entry.pendingPosition) {
      editor.setPosition(entry.pendingPosition);
      editor.revealLineInCenter(entry.pendingPosition.lineNumber);
      entry.pendingPosition = null;
    }
    hidePlaceholder();
    editor.focus();
    emit('cursor', editor.getPosition() || { lineNumber: 1, column: 1 });
  } else {
    editor.setModel(null);
    showPlaceholder(binaryPlaceholder(entry));
  }
  emit('active', entry);
  emit('tabs');
}

/** Jump to a line and column in a file (used by the Problems tab). */
export function revealPosition(path, lineNumber, column = 1) {
  const entry = findEntry(path);
  if (!entry || entry.kind !== 'text') return;
  activateFile(path);
  editor.setPosition({ lineNumber, column });
  editor.revealLineInCenter(lineNumber);
  editor.focus();
}

/** Close a tab. Asks first when there are unsaved changes. Resolves to true when closed. */
export async function closeFile(path) {
  const entry = findEntry(path);
  if (!entry || entry.scratch) return false;
  if (entry.dirty) {
    const discard = await confirmDialog({
      title: `Close ${entry.name} without saving?`,
      message: 'The changes you made since the last save will be lost.',
      confirmLabel: 'Close without saving',
      cancelLabel: 'Keep editing',
      danger: true,
    });
    if (!discard) return false;
  }

  const index = state.openFiles.indexOf(entry);
  if (index === -1) return false; // closed meanwhile
  state.openFiles.splice(index, 1);
  entry.model?.dispose();

  if (state.activePath === path) {
    const next = state.openFiles[index] || state.openFiles[index - 1];
    if (next) {
      activateFile(next.path);
    } else {
      state.activePath = null;
      editor.setModel(null);
      showPlaceholder(emptyPlaceholder());
      emit('active', null);
    }
  }
  emit('tabs');
  return true;
}

/** Close every tab without asking (the caller has already checked for unsaved changes). */
export function closeAllFiles() {
  for (const entry of state.openFiles) entry.model?.dispose();
  state.openFiles = [];
  state.activePath = null;
  if (editor) {
    editor.setModel(null);
    showPlaceholder(emptyPlaceholder());
  }
  emit('active', null);
  emit('tabs');
}

/**
 * Save one file back into the folder it was opened from.
 *
 * With a real folder (Chrome, Edge, Opera, Brave) this writes straight to the file on your
 * disk — same folder, same name, same subfolder. Firefox and Safari have no API that can
 * write to your disk at all, so there the edit is kept in the editor's copy of the folder
 * and "Save Folder" packs the lot back up as a zip; `needsExport` is what remembers that
 * there is something waiting to be packed.
 */
export async function saveFile(path) {
  const entry = findEntry(path);
  if (!entry || entry.kind !== 'text' || entry.scratch) return;

  // Capture text AND version together: keystrokes typed while the write is in progress
  // must stay marked as unsaved.
  const text = entry.model.getValue();
  const version = entry.model.getAlternativeVersionId();

  const backend = fs.current();
  await fs.writeText(path, text); // memory backends keep the new text so reopening the tab shows it

  entry.savedVersion = version;
  entry.dirty = entry.model.getAlternativeVersionId() !== version;
  emit('tabs');
  emit('saved', entry);

  if (backend.kind === 'native') {
    toast(`Saved ${entry.name} to "${backend.name}"`, 'success', 1800);
    return;
  }

  // Nothing reached the disk, so say so and point at the way that does.
  markNeedsExport();
  if (backend.sample) {
    toast(`Saved ${entry.name} in the sample project (memory only). Save Folder downloads it as a zip.`, 'info', 4000);
  } else {
    toast(
      `Saved ${entry.name} in the editor. This browser cannot write to "${backend.name}" — ` +
      `use Save Folder to download ${backend.name}.zip and unzip it over the original.`,
      'warning', 6500,
    );
  }
}

/** Remember that the open folder holds edits that have not made it back to the disk yet. */
export function markNeedsExport(value = true) {
  if (!state.folder || state.folder.needsExport === value) return;
  state.folder.needsExport = value;
  emit('folder', state.folder);
}

export async function saveAll() {
  for (const entry of [...state.openFiles]) {
    if (entry.dirty && !entry.scratch) await saveFile(entry.path);
  }
}

/**
 * Where the cursor sits in every open file. Stored alongside the folder so that reopening
 * it puts each tab back on the line you left it on.
 */
export function openFilePositions() {
  const positions = [];
  for (const entry of state.openFiles) {
    if (entry.scratch || entry.kind !== 'text') continue;
    let position = entry.viewState?.cursorState?.[0]?.position || entry.pendingPosition || null;
    if (entry.path === state.activePath && editor && editor.getModel() === entry.model) {
      position = editor.getPosition() || position;
    }
    positions.push({
      path: entry.path,
      lineNumber: position?.lineNumber || 1,
      column: position?.column || 1,
    });
  }
  return positions;
}

/* ---------- Scratch file (no folder open) ---------- */

function createScratchModel(lang, content) {
  const uri = monaco.Uri.parse(`inmemory://scratch/untitled.${lang.ext}`);
  monaco.editor.getModel(uri)?.dispose();
  const model = monaco.editor.createModel(content, lang.monaco, uri);
  applyModelOptions(model);
  return model;
}

export function openScratch(lang, content) {
  const model = createScratchModel(lang, content);
  const entry = {
    path: SCRATCH_PATH,
    name: `untitled.${lang.ext}`,
    kind: 'text',
    scratch: true,
    language: lang,
    model,
    dirty: false,
    viewState: null,
  };
  watchModel(entry);
  state.openFiles.unshift(entry);
  activateFile(SCRATCH_PATH);
  emit('tabs');
  return entry;
}

/**
 * Rename the scratch tab. Once the scratch file has a home on disk the tab stops saying
 * "untitled" and shows the real file name instead, so you can see where Ctrl+S will land.
 */
export function setScratchName(name) {
  const entry = state.openFiles.find((f) => f.scratch);
  if (!entry || entry.name === name) return;
  entry.name = name;
  emit('tabs');
  if (state.activePath === SCRATCH_PATH) emit('active', entry);
}

/** Swap the scratch file to another language (the tab name and colouring change). */
export function replaceScratchModel(lang, content) {
  const entry = state.openFiles.find((f) => f.scratch);
  if (!entry) return;
  const old = entry.model;
  if (editor.getModel() === old) editor.setModel(null);
  old.dispose();
  entry.model = createScratchModel(lang, content);
  entry.language = lang;
  entry.name = `untitled.${lang.ext}`;
  entry.viewState = null;
  watchModel(entry);
  if (state.activePath === SCRATCH_PATH) {
    editor.setModel(entry.model);
    editor.focus();
  }
  emit('tabs');
  emit('active', entry);
}

export function removeScratch() {
  const index = state.openFiles.findIndex((f) => f.scratch);
  if (index === -1) return;
  const [entry] = state.openFiles.splice(index, 1);
  if (editor.getModel() === entry.model) editor.setModel(null);
  entry.model.dispose();
  if (state.activePath === SCRATCH_PATH) {
    state.activePath = null;
    showPlaceholder(emptyPlaceholder());
    emit('active', null);
  }
  emit('tabs');
}

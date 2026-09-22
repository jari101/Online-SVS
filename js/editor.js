// js/editor.js — loads Monaco (the editor inside VS Code) and manages the open files:
// one Monaco "model" per open file, the active tab, dirty flags and saving.

import { CONFIG } from './config.js';
import { state, emit } from './state.js';
import * as fs from './fs/index.js';
import { fontById } from './fonts.js';
import { toast } from './toast.js';
import { icons } from './icons.js';
import { escapeHtml, formatBytes } from './dom.js';
import { confirmDialog } from './dialog.js';
import { showImage, releaseImage } from './imageview.js';

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
  releaseImage(placeholderEl);
  placeholderEl.innerHTML = html;
  placeholderEl.hidden = false;
}

function hidePlaceholder() {
  placeholderEl.hidden = true;
}

function emptyPlaceholder() {
  return `
    <div class="placeholder-content">
      <div class="placeholder-logo">${icons.logo}</div>
      <h2>${escapeHtml(CONFIG.appName)}</h2>
      <p>Open a file from the Explorer to start editing.</p>
      <div class="shortcuts">
        <span>Save file</span><span><kbd>Ctrl</kbd> + <kbd>S</kbd></span>
        <span>Go to file</span><span><kbd>Ctrl</kbd> + <kbd>P</kbd></span>
        <span>Search in files</span><span><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd></span>
        <span>Toggle sidebar</span><span><kbd>Ctrl</kbd> + <kbd>B</kbd></span>
        <span>Toggle bottom panel</span><span><kbd>Ctrl</kbd> + <kbd>J</kbd></span>
        <span>Settings</span><span><kbd>Ctrl</kbd> + <kbd>,</kbd></span>
      </div>
    </div>`;
}

function binaryPlaceholder(entry) {
  const size = entry.size === undefined ? '' : `<p class="muted small">${escapeHtml(formatBytes(entry.size))}</p>`;
  return `
    <div class="placeholder-content">
      <div class="placeholder-logo">${icons.file}</div>
      <h2>${escapeHtml(entry.name)}</h2>
      <p>This is a binary file (a font, an archive, a program…), so it cannot be edited as text.</p>
      ${size}
      <p class="muted small">It is still part of your folder: the live preview serves it and Save Folder packs it up.</p>
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
      // The size is worth showing and cheap to ask for, but a folder that cannot answer
      // should still open the tab.
      const size = await fs.stat(path).then((s) => s.size, () => undefined);
      entry = { path, name, kind: 'binary', dirty: false, size, objectUrl: null };
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
  } else if (fs.isImagePath(entry.path)) {
    editor.setModel(null);
    showImage(placeholderEl, entry).catch((err) => {
      console.error(err);
      showPlaceholder(binaryPlaceholder(entry));
    });
    placeholderEl.hidden = false;
  } else {
    editor.setModel(null);
    showPlaceholder(binaryPlaceholder(entry));
  }
  emit('active', entry);
  emit('tabs');
}

/** Jump to a line and column in a file that is already open (used by the Problems tab). */
export function revealPosition(path, lineNumber, column = 1, length = 0) {
  const entry = findEntry(path);
  if (!entry || entry.kind !== 'text') return;
  activateFile(path);
  if (length > 0) editor.setSelection({ startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column + length });
  else editor.setPosition({ lineNumber, column });
  editor.revealLineInCenter(lineNumber);
  editor.focus();
}

/**
 * Jump to a place in any file of the folder, opening it first if it is not open yet.
 * `length` highlights that many characters, which is how a search result shows what it found.
 */
export async function gotoLocation(path, lineNumber, column = 1, length = 0) {
  if (!findEntry(path)) await openFile(path, { activate: false });
  revealPosition(path, lineNumber, column, length);
}

/* ---------- Renaming and reloading ---------- */

/**
 * Follow a renamed file (or a renamed folder) in the open tabs.
 *
 * A Monaco model is tied to its URI for life — the URI is what gives the file its language —
 * so the model is built again under the new path. The text goes along untouched, including
 * unsaved changes, and a tab that was showing the file keeps showing it.
 */
export function retargetOpenFiles(oldPath, newPath) {
  const affected = state.openFiles.filter((f) => !f.scratch && (f.path === oldPath || f.path.startsWith(oldPath + '/')));
  if (!affected.length) return;
  const pathFor = (path) => (path === oldPath ? newPath : newPath + path.slice(oldPath.length));
  // Was the tab on screen one of the renamed ones? Only then does the editor need touching:
  // a saved view state is from the last time a tab was left, so restoring it on a tab nobody
  // renamed would drag the cursor back to where it used to be.
  const showingAffected = affected.some((entry) => entry.path === state.activePath);

  for (const entry of affected) {
    const wasActive = state.activePath === entry.path;
    const target = pathFor(entry.path);

    if (entry.kind === 'text') {
      const text = entry.model.getValue();
      const wasDirty = entry.dirty;
      const viewState = wasActive && editor.getModel() === entry.model
        ? editor.saveViewState()
        : entry.viewState;
      if (editor.getModel() === entry.model) editor.setModel(null);
      entry.model.dispose();

      const uri = monaco.Uri.file('/' + target);
      monaco.editor.getModel(uri)?.dispose();
      entry.model = monaco.editor.createModel(text, undefined, uri);
      applyModelOptions(entry.model);
      entry.viewState = viewState;
      // A fresh model starts at version 1, so unsaved changes are kept dirty by hand.
      entry.savedVersion = wasDirty ? -1 : entry.model.getAlternativeVersionId();
      entry.dirty = wasDirty;
      watchModel(entry);
    }

    entry.path = target;
    entry.name = fs.baseName(target);
    if (wasActive) state.activePath = target;
  }

  emit('tabs');
  if (!showingAffected) return;
  const active = findEntry(state.activePath);
  if (!active) return;
  if (active.kind === 'text') {
    editor.setModel(active.model);
    if (active.viewState) editor.restoreViewState(active.viewState);
    emit('active', active);
  } else {
    activateFile(active.path); // an image tab is drawn from the entry, so it redraws its name
  }
}

/**
 * Put the text from the disk into an open tab, keeping the cursor, the scroll position and
 * the undo history — that is what makes a file changed by another program simply update
 * rather than jump. Returns false when the tab is not there any more.
 */
export function reloadFile(path, text) {
  const entry = findEntry(path);
  if (!entry || entry.kind !== 'text' || entry.model.isDisposed()) return false;
  const { model } = entry;

  if (model.getValue() !== text) {
    const showing = editor.getModel() === model;
    const viewState = showing ? editor.saveViewState() : null;
    // An edit operation rather than setValue(): setValue throws the undo history away.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    if (showing && viewState) editor.restoreViewState(viewState);
  }
  entry.savedVersion = model.getAlternativeVersionId();
  entry.dirty = false;
  emit('tabs');
  return true;
}

/**
 * Close the tabs of files that are no longer there (they have just been deleted), without
 * asking about unsaved changes — the deletion was already confirmed.
 */
export function closeFilesUnder(path) {
  const gone = state.openFiles.filter((f) => !f.scratch && (f.path === path || f.path.startsWith(path + '/')));
  if (!gone.length) return;
  const stillShowing = gone.some((f) => f.path === state.activePath);

  for (const entry of gone) {
    const index = state.openFiles.indexOf(entry);
    if (index !== -1) state.openFiles.splice(index, 1);
    disposeEntry(entry);
  }

  if (stillShowing) {
    const next = state.openFiles[0];
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
}

/** Let go of everything a closed tab was holding: its model, and any image it had loaded. */
function disposeEntry(entry) {
  entry.model?.dispose();
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = null;
  }
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
  disposeEntry(entry);

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
  for (const entry of state.openFiles) disposeEntry(entry);
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
  if (backend.kind === 'zip') {
    toast(
      `Saved ${entry.name} in the editor's copy of ${backend.zip.fileName}. Save Folder ` +
      (backend.zip.handle ? `writes it back into ${backend.zip.fileName}.` : `downloads ${backend.zip.fileName} with your edits.`),
      'info', 4500,
    );
  } else if (backend.sample) {
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

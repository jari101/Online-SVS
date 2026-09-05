// js/editor.js — loads Monaco (the editor inside VS Code) and manages the open files:
// one Monaco "model" per open file, the active tab, dirty flags and saving.

import { CONFIG } from './config.js';
import { state, emit } from './state.js';
import * as fs from './fs/index.js';
import { fontById } from './fonts.js';
import { toast } from './toast.js';
import { icons } from './icons.js';
import { escapeHtml, downloadText } from './dom.js';
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

function emptyPlaceholder() {
  return `
    <div class="placeholder-content">
      <div class="placeholder-logo">${icons.logo}</div>
      <h2>${escapeHtml(CONFIG.appName)}</h2>
      <p>Open a file from the Explorer to start editing.</p>
      <div class="shortcuts">
        <span>Save file</span><span><kbd>Ctrl</kbd> + <kbd>S</kbd></span>
        <span>Toggle sidebar</span><span><kbd>Ctrl</kbd> + <kbd>B</kbd></span>
        <span>Toggle bottom panel</span><span><kbd>Ctrl</kbd> + <kbd>J</kbd></span>
        <span>Settings</span><span><kbd>Ctrl</kbd> + <kbd>,</kbd></span>
      </div>
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

/** Open a file from the current folder in a tab (reads it from disk the first time). */
export function openFile(path, { activate = true } = {}) {
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
    if (entry.viewState) editor.restoreViewState(entry.viewState);
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

/** Save one file to the folder (or download it when the folder cannot be written). */
export async function saveFile(path) {
  const entry = findEntry(path);
  if (!entry || entry.kind !== 'text') return;

  // Capture text AND version together: keystrokes typed while the write is in progress
  // must stay marked as unsaved.
  const text = entry.model.getValue();
  const version = entry.model.getAlternativeVersionId();

  if (entry.scratch) {
    downloadText(entry.name, text);
    toast(`Downloaded ${entry.name}. The scratch file is also kept in this browser automatically.`, 'info');
    return;
  }

  const backend = fs.current();
  await fs.writeText(path, text); // memory backends keep the new text so reopening the tab shows it
  if (backend.readOnly) downloadText(entry.name, text);

  entry.savedVersion = version;
  entry.dirty = entry.model.getAlternativeVersionId() !== version;
  emit('tabs');
  emit('saved', entry);

  if (backend.readOnly) toast(`This browser cannot write to your folder, so ${entry.name} was downloaded instead.`, 'warning', 4500);
  else if (backend.sample) toast(`Saved ${entry.name} (sample project, in memory only)`, 'success', 1800);
  else toast(`Saved ${entry.name}`, 'success', 1800);
}

export async function saveAll() {
  for (const entry of [...state.openFiles]) {
    if (entry.dirty && !entry.scratch) await saveFile(entry.path);
  }
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

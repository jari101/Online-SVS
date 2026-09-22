// js/panel.js — the bottom panel: Output (what your program printed), Input (what it reads)
// and Problems (errors and warnings Monaco found in the open files).
//
// Output also turns the places a compiler mentions — "main.cpp:12:5", 'File "main.py", line 7',
// "(Main.java:5)" — into buttons that jump to that line, but only when the file they name is
// one we can actually open.

import { state, on, emit } from './state.js';
import { getMonaco, revealPosition, gotoLocation, SCRATCH_PATH } from './editor.js';
import * as fs from './fs/index.js';
import { icons } from './icons.js';
import { escapeHtml, $ } from './dom.js';
import { togglePanel } from './layout.js';

let outputEl = null;
let problemsEl = null;
let countEl = null;

export function initPanel() {
  outputEl = $('output-text');
  problemsEl = $('problems-list');
  countEl = $('problems-count');

  const header = $('panel').querySelector('.panel-header');
  header.addEventListener('click', (e) => {
    const tab = e.target.closest('.panel-tab');
    if (tab) showPanelTab(tab.dataset.tab);
  });
  header.addEventListener('keydown', (e) => {
    const tabs = [...header.querySelectorAll('.panel-tab')];
    const current = e.target.closest('.panel-tab');
    if (!current) return;
    const index = tabs.indexOf(current);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    if (next) {
      e.preventDefault();
      showPanelTab(next.dataset.tab);
      next.focus();
    }
  });
  $('btn-panel-close').addEventListener('click', () => togglePanel(false));

  const stdin = $('stdin-input');
  stdin.addEventListener('input', () => {
    state.stdin = stdin.value;
  });

  on('editor-ready', ({ monaco }) => {
    // Monaco re-checks a file shortly after you stop typing and then fires this event.
    monaco.editor.onDidChangeMarkers(scheduleProblems);
  });
  on('tabs', scheduleProblems);
  renderProblems();
}

export function showPanelTab(name) {
  for (const tab of document.querySelectorAll('.panel-tab')) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const content of document.querySelectorAll('.panel-content')) {
    content.hidden = content.id !== `panel-${name}`;
  }
  togglePanel(true);
}

export function clearOutput() {
  outputEl.textContent = '';
}

/** Append a piece of text to the Output tab. `cls` can be 'stderr', 'error', 'success', 'info'. */
export function appendOutput(text, cls = '') {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.append(linkify(text));
  outputEl.appendChild(span);
  outputEl.parentElement.scrollTop = outputEl.parentElement.scrollHeight;
}

/* ---------- Turning "main.cpp:12:5" into something you can click ---------- */

/**
 * What the last run called the file it sent, and which of our files that was. The service is
 * given a name of its own choosing for the scratch file ("main.cpp" for C++), and that is the
 * name the compiler then talks about, so without this the scratch file's own errors would not
 * be clickable. Set by js/runner.js before each run.
 */
let runContext = null;

export function setRunContext(context) {
  runContext = context;
}

// Two shapes cover every compiler and runtime the Run button can reach: Python's own wording,
// and "name:line" (optionally ":column"), which is what C, C++, Java, Node, Go and the rest
// all print, with or without a folder in front of the name.
const LOCATION_PATTERNS = [
  /File "([^"\n]+)", line (\d+)/g,
  /([A-Za-z0-9_+\-./\\]*[A-Za-z0-9_+\-]\.[A-Za-z][A-Za-z0-9]*):(\d+)(?::(\d+))?/g,
];

/** Every file in the open folder, as paths. */
function treePaths(node, out = []) {
  if (!node) return out;
  if (node.kind === 'file') out.push(node.path);
  else for (const child of node.children) treePaths(child, out);
  return out;
}

/**
 * Which of our files is the compiler talking about? The service runs the files under its own
 * names in its own folder ("/box/main.cpp"), so an exact path is tried first and the plain
 * file name after that. Returns null when nothing here matches, and the text stays text.
 */
function resolveFile(reference) {
  const cleaned = reference.replace(/\\/g, '/').replace(/^\.\//, '');
  const name = fs.baseName(cleaned);

  if (runContext && (runContext.name === name || runContext.name === cleaned)) return runContext.path;

  const scratch = state.openFiles.find((f) => f.scratch);
  if (scratch && (scratch.name === name || scratch.name === cleaned)) return SCRATCH_PATH;

  if (state.mode !== 'folder' || !state.tree) return null;
  if (fs.findNode(state.tree, cleaned)?.kind === 'file') return cleaned;

  const open = state.openFiles.find((f) => !f.scratch && f.name === name);
  if (open) return open.path;

  const candidates = treePaths(state.tree).filter((path) => fs.baseName(path) === name);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  // Several files share the name: the one beside the file you ran is the likely one.
  const activeDir = state.activePath ? fs.parentOf(state.activePath) : '';
  return candidates.find((path) => fs.parentOf(path) === activeDir) || candidates[0];
}

/** Find the file positions in `text` and hand back where they are, without overlaps. */
function findLocations(text) {
  const found = [];
  for (const pattern of LOCATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      found.push({
        start: match.index,
        end: match.index + match[0].length,
        label: match[0],
        reference: match[1],
        line: Number(match[2]),
        column: Number(match[3] || 1),
      });
    }
  }
  found.sort((a, b) => a.start - b.start);
  return found.filter((item, index) => index === 0 || item.start >= found[index - 1].end);
}

function linkify(text) {
  const fragment = document.createDocumentFragment();
  // A stack trace names the same file over and over; look each one up once.
  const seen = new Map();
  const lookUp = (reference) => {
    if (!seen.has(reference)) seen.set(reference, resolveFile(reference));
    return seen.get(reference);
  };

  let at = 0;
  for (const location of findLocations(text)) {
    const path = lookUp(location.reference);
    if (!path) continue;
    fragment.append(text.slice(at, location.start));
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'out-link';
    link.textContent = location.label;
    link.title = `Go to ${path} line ${location.line}`;
    link.addEventListener('click', () => {
      gotoLocation(path, location.line, location.column).catch((err) => console.error(err));
    });
    fragment.append(link);
    at = location.end;
  }
  fragment.append(text.slice(at));
  return fragment;
}

/* ---------- Problems ---------- */

/** Errors and warnings for every open text file, straight from Monaco's markers. */
export function collectProblems() {
  const monaco = getMonaco();
  if (!monaco) return [];
  const problems = [];
  for (const file of state.openFiles) {
    if (!file.model) continue;
    for (const marker of monaco.editor.getModelMarkers({ resource: file.model.uri })) {
      const isError = marker.severity === monaco.MarkerSeverity.Error;
      const isWarning = marker.severity === monaco.MarkerSeverity.Warning;
      if (!isError && !isWarning) continue;
      problems.push({ file, marker, isError });
    }
  }
  return problems;
}

/** How many errors (not warnings) the open files have right now. The live server uses this. */
export function errorCount() {
  return collectProblems().filter((p) => p.isError).length;
}

let problemsQueued = false;

/** Markers change on nearly every keystroke, so redraw the list at most once per frame. */
function scheduleProblems() {
  if (problemsQueued) return;
  problemsQueued = true;
  requestAnimationFrame(() => {
    problemsQueued = false;
    renderProblems();
  });
}

function renderProblems() {
  if (!problemsEl) return;
  const problems = collectProblems();
  const errors = problems.filter((p) => p.isError).length;

  countEl.textContent = String(problems.length);
  countEl.hidden = problems.length === 0;
  countEl.classList.toggle('error', errors > 0);

  problemsEl.innerHTML = '';
  if (!problems.length) {
    problemsEl.innerHTML = '<li class="empty">No problems have been detected in the open files.</li>';
  }
  for (const p of problems) {
    const li = document.createElement('li');
    const kind = p.isError ? 'Error' : 'Warning';
    li.innerHTML = `
      <button class="problem" type="button" title="Go to ${escapeHtml(p.file.name)} line ${p.marker.startLineNumber}">
        <span class="sev ${p.isError ? 'sev-error' : 'sev-warning'}" aria-label="${kind}">${p.isError ? icons.error : icons.warning}</span>
        <span class="msg">${escapeHtml(p.marker.message)}</span>
        <span class="loc">${escapeHtml(p.file.name)} [${p.marker.startLineNumber}, ${p.marker.startColumn}]</span>
      </button>`;
    li.querySelector('button').addEventListener('click', () => revealPosition(p.file.path, p.marker.startLineNumber, p.marker.startColumn));
    problemsEl.appendChild(li);
  }
  emit('problems', { errors, total: problems.length });
}

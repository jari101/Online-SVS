// js/panel.js — the bottom panel: Output (what your program printed, and where it ran),
// Input (the text handed to the program as stdin) and Problems (errors and warnings Monaco
// found in the open files).

import { state, on, emit } from './state.js';
import { getMonaco, revealPosition } from './editor.js';
import { icons } from './icons.js';
import { escapeHtml, $ } from './dom.js';
import { togglePanel } from './layout.js';

let outputEl = null;
let metaEl = null;
let whereEl = null;
let engineEl = null;
let problemsEl = null;
let countEl = null;

export function initPanel() {
  outputEl = $('output-text');
  metaEl = $('output-meta');
  whereEl = $('output-where');
  engineEl = $('output-engine');
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
  if (metaEl) metaEl.hidden = true;
}

/**
 * The line above the output saying where this program ran.
 * `where` is 'browser' or 'server'; `engine` is what ran it ("Python 3.14.0"); `host` is the
 * machine a server run was sent to. Called more than once per run, because a version is only
 * known once the runtime is up.
 */
export function setRunLocation({ where, engine, host } = {}) {
  if (!metaEl) return;
  metaEl.hidden = false;
  if (where) {
    const remote = where === 'server';
    metaEl.classList.toggle('remote', remote);
    whereEl.textContent = remote
      ? `sent to ${host || 'your code runner'}`
      : 'in your browser';
    metaEl.title = remote
      ? 'This program was sent to the code runner set up in Settings.'
      : 'This program ran inside this browser tab. Your code did not leave the machine.';
  }
  if (engine) engineEl.textContent = engine;
}

/** Append a piece of text to the Output tab. `cls` can be 'stderr', 'error', 'success', 'info'. */
export function appendOutput(text, cls = '') {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  outputEl.appendChild(span);
  outputEl.parentElement.scrollTop = outputEl.parentElement.scrollHeight;
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

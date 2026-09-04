// js/panel.js — the bottom panel: Output (program output, Phase 3), Input (stdin, Phase 3)
// and Problems (errors and warnings Monaco found in the open files).

import { state, on, emit } from './state.js';
import { getMonaco, revealPosition } from './editor.js';
import { icons } from './icons.js';
import { escapeHtml } from './dom.js';
import { togglePanel } from './layout.js';

let outputEl = null;
let problemsEl = null;
let countEl = null;

export function initPanel() {
  const panel = document.getElementById('panel');
  outputEl = document.getElementById('output-text');
  problemsEl = document.getElementById('problems-list');
  countEl = document.getElementById('problems-count');

  panel.querySelector('.panel-header').addEventListener('click', (e) => {
    const tab = e.target.closest('.panel-tab');
    if (tab) showPanelTab(tab.dataset.tab);
  });
  document.getElementById('btn-panel-close').addEventListener('click', () => togglePanel(false));

  const stdin = document.getElementById('stdin-input');
  stdin.addEventListener('input', () => {
    state.stdin = stdin.value;
  });

  on('editor-ready', ({ monaco }) => {
    // Monaco re-checks a file shortly after you stop typing and then fires this event.
    monaco.editor.onDidChangeMarkers(() => renderProblems());
  });
  on('tabs', renderProblems);
  renderProblems();
}

export function showPanelTab(name) {
  for (const tab of document.querySelectorAll('.panel-tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
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

export function errorCount() {
  return collectProblems().filter((p) => p.isError).length;
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
    li.innerHTML = `
      <span class="sev ${p.isError ? 'sev-error' : 'sev-warning'}">${p.isError ? icons.error : icons.warning}</span>
      <span class="msg">${escapeHtml(p.marker.message)}</span>
      <span class="loc">${escapeHtml(p.file.name)} [${p.marker.startLineNumber}, ${p.marker.startColumn}]</span>`;
    li.addEventListener('click', () => revealPosition(p.file.path, p.marker.startLineNumber, p.marker.startColumn));
    problemsEl.appendChild(li);
  }
  emit('problems', { errors, total: problems.length });
}

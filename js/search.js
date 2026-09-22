// js/search.js — the Search view in the sidebar: find a piece of text anywhere in the folder
// you have open, and click a result to land on that line.
//
// It reads the files itself rather than relying on what is open, so a match in a file you have
// never opened still shows up. Files you *have* open are read from the editor instead of the
// disk, so what you just typed is searched too — even before you save it.
//
// Nothing is indexed and nothing is remembered: every search walks the folder again. That is
// plenty for a website, and it means a file you change is never matched against a stale copy.

import { state, on } from './state.js';
import * as fs from './fs/index.js';
import { openTextOf, gotoLocation, getEditor } from './editor.js';
import { icons, fileTypeClass } from './icons.js';
import { escapeHtml, el, mapLimit, $ } from './dom.js';
import { showSidebarView } from './layout.js';
import { toast } from './toast.js';

const TYPING_PAUSE = 300;              // ms of quiet before a search starts
const MAX_RESULTS = 2000;              // enough to find anything; small enough to stay quick
const MAX_FILE_BYTES = 1024 * 1024;    // bigger files are skipped, and the status bar says so
const MAX_PREVIEW = 200;               // characters of the line shown in a result row
const READ_AT_ONCE = 8;

let host = null;
let resultsEl = null;
let statusEl = null;
let typingTimer = null;
let searchToken = 0;
let query = '';
const options = { matchCase: false, regex: false };
const collapsed = new Set();           // paths whose matches are folded away
let results = [];                      // [{ path, name, matches: [{ line, column, length, before, hit, after }] }]
let focusedRow = 0;                    // which result row has the keyboard focus (roving tabindex)

export function initSearch(container) {
  host = container;
  // Clicking the magnifying glass should put the cursor in the box, not just show it.
  on('sidebar-view', (view) => {
    if (view === 'search') $('search-input')?.focus();
  });
  on('folder', () => {
    // A different folder means the old results point at files that are no longer there.
    results = [];
    collapsed.clear();
    query = '';
    render();
  });
  render();
}

/**
 * Show the Search view and put the cursor in its box. `seed` prefills it — the Ctrl+Shift+F
 * shortcut passes whatever is selected in the editor, like VS Code does.
 */
export function focusSearch(seed = null) {
  showSidebarView('search');
  const input = $('search-input');
  if (!input) return;
  if (seed && seed !== query) {
    input.value = seed;
    query = seed;
    runSearch();
  }
  input.focus();
  input.select();
}

/** The word or line the editor has selected, when it is short enough to be a search term. */
export function selectionInEditor() {
  const editor = getEditor();
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  if (!model || !selection || selection.isEmpty()) return null;
  if (selection.startLineNumber !== selection.endLineNumber) return null;
  const text = model.getValueInRange(selection);
  return text.length && text.length <= 200 ? text : null;
}

/* ---------- Drawing the view ---------- */

function render() {
  if (!host) return;
  host.innerHTML = `
    <h2 class="sidebar-title">Search</h2>
    <div class="search-head">
      <div class="search-field">
        <input id="search-input" type="text" spellcheck="false" placeholder="Find in folder"
               aria-label="Text to find in the files of the open folder" value="${escapeHtml(query)}">
        <span class="search-toggles">
          <button type="button" class="search-toggle" data-toggle="matchCase" aria-pressed="${options.matchCase}"
                  title="Match case" aria-label="Match case">Aa</button>
          <button type="button" class="search-toggle" data-toggle="regex" aria-pressed="${options.regex}"
                  title="Use a regular expression" aria-label="Use a regular expression">.*</button>
        </span>
      </div>
      <p class="search-status" id="search-status" role="status"></p>
    </div>
    <div class="search-results" id="search-results"></div>`;

  resultsEl = $('search-results');
  statusEl = $('search-status');

  const input = $('search-input');
  input.addEventListener('input', () => {
    query = input.value;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(runSearch, TYPING_PAUSE);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(typingTimer);
      runSearch();
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      input.value = '';
      query = '';
      runSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(0);
    }
  });

  for (const button of host.querySelectorAll('.search-toggle')) {
    button.addEventListener('click', () => {
      const key = button.dataset.toggle;
      options[key] = !options[key];
      button.setAttribute('aria-pressed', String(options[key]));
      runSearch();
    });
  }

  resultsEl.addEventListener('keydown', onResultsKeydown);
  renderResults();
}

function renderResults({ status = null, error = false, truncated = false, skipped = 0 } = {}) {
  if (!resultsEl) return;
  resultsEl.innerHTML = '';
  statusEl.classList.toggle('error', error);

  const total = results.reduce((sum, file) => sum + file.matches.length, 0);
  if (status) {
    statusEl.textContent = status;
  } else if (!query) {
    statusEl.textContent = '';
  } else {
    const files = results.length;
    statusEl.textContent = total
      ? `${total} result${total === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`
        + (truncated ? ` (the first ${MAX_RESULTS} are shown)` : '')
        + (skipped ? ` · ${skipped} large file${skipped === 1 ? '' : 's'} skipped` : '')
      : `No results for "${query}"`;
  }

  if (!fs.hasFolder()) {
    resultsEl.innerHTML = '<p class="search-empty muted">Open a folder and its files can be searched here. The scratch file is searched with Ctrl+F in the editor.</p>';
    return;
  }
  if (!query) {
    resultsEl.innerHTML = `<p class="search-empty muted">Type to search every file in "${escapeHtml(state.folder.name)}". Unsaved changes are searched too.</p>`;
    return;
  }
  if (!results.length) return;

  const fragment = document.createDocumentFragment();
  for (const file of results) {
    const isCollapsed = collapsed.has(file.path);
    const header = el('button', 'search-file');
    header.type = 'button';
    header.dataset.row = '';
    header.dataset.file = file.path;
    header.setAttribute('aria-expanded', String(!isCollapsed));
    header.title = file.path;
    header.innerHTML = `
      <span class="search-chevron">${isCollapsed ? icons.chevronRight : icons.chevronDown}</span>
      <span class="tree-icon ${fileTypeClass(file.name)}">${icons.file}</span>
      <span class="search-file-name">${escapeHtml(file.name)}</span>
      <span class="search-file-dir">${escapeHtml(fs.parentOf(file.path))}</span>
      <span class="badge">${file.matches.length}</span>`;
    header.addEventListener('click', () => {
      if (collapsed.has(file.path)) collapsed.delete(file.path);
      else collapsed.add(file.path);
      renderResults();
      focusRow(rowIndexOfFile(file.path));
    });
    fragment.appendChild(header);

    if (isCollapsed) continue;
    for (const match of file.matches) {
      const row = el('button', 'search-match');
      row.type = 'button';
      row.dataset.row = '';
      row.title = `${file.path}:${match.line}:${match.column}`;
      row.innerHTML = `
        <span class="search-line">${match.line}</span>
        <span class="search-text"></span>`;
      const hit = el('mark');
      hit.textContent = match.hit;
      // Built as nodes rather than HTML, so a file full of angle brackets stays text.
      row.querySelector('.search-text').append(match.before, hit, match.after);
      row.addEventListener('click', () => {
        // The folder may have moved on since the search ran.
        gotoLocation(file.path, match.line, match.column, match.length)
          .catch((err) => toast(`Unable to open ${file.path}: ${err.message}`, 'error'));
      });
      fragment.appendChild(row);
    }
  }
  resultsEl.appendChild(fragment);
  syncRowTabIndex();
}

/* ---------- Keyboard ---------- */

function rows() {
  return resultsEl ? [...resultsEl.querySelectorAll('[data-row]')] : [];
}

function rowIndexOfFile(path) {
  return rows().findIndex((row) => row.dataset.file === path);
}

function syncRowTabIndex() {
  const all = rows();
  if (!all.length) return;
  focusedRow = Math.max(0, Math.min(focusedRow, all.length - 1));
  all.forEach((row, index) => { row.tabIndex = index === focusedRow ? 0 : -1; });
}

function focusRow(index) {
  const all = rows();
  if (!all.length) return;
  focusedRow = Math.max(0, Math.min(index, all.length - 1));
  syncRowTabIndex();
  all[focusedRow].focus();
}

function onResultsKeydown(e) {
  const all = rows();
  const index = all.indexOf(e.target.closest('[data-row]'));
  if (index === -1) return;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusRow(index + 1); break;
    case 'ArrowUp':
      e.preventDefault();
      if (index === 0) $('search-input').focus();
      else focusRow(index - 1);
      break;
    case 'Home': e.preventDefault(); focusRow(0); break;
    case 'End': e.preventDefault(); focusRow(all.length - 1); break;
    default: break;
  }
}

/* ---------- Doing the search ---------- */

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the regular expression to look for, or an error message to show instead. */
function buildMatcher() {
  const flags = options.matchCase ? 'g' : 'gi';
  if (!options.regex) return { regex: new RegExp(escapeRegex(query), flags) };
  try {
    return { regex: new RegExp(query, flags) };
  } catch (err) {
    return { error: `That is not a valid regular expression: ${err.message}` };
  }
}

function collectPaths(node, out = []) {
  if (!node) return out;
  if (node.kind === 'file') out.push(node.path);
  else for (const child of node.children) collectPaths(child, out);
  return out;
}

/** Cut a long line down to something that fits a sidebar, keeping the match in view. */
function preview(line, start, end) {
  // The indent of a nested line says nothing in a narrow list, so it is left out — unless the
  // match itself is in there, in which case it has to stay for the highlight to line up.
  let from = Math.min(line.length - line.trimStart().length, start);
  let to = line.length;
  if (to - from > MAX_PREVIEW) {
    from = Math.max(from, start - 30);
    to = Math.min(line.length, from + MAX_PREVIEW);
  }
  const cutBefore = from > line.length - line.trimStart().length;
  return {
    before: (cutBefore ? '…' : '') + line.slice(from, start),
    hit: line.slice(start, end),
    after: line.slice(end, to) + (to < line.length ? '…' : ''),
  };
}

function matchesIn(text, regex) {
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      found.push({ line: i + 1, column: start + 1, length: match[0].length, ...preview(line, start, end) });
      // A pattern that can match nothing ("a*") would otherwise loop for ever.
      regex.lastIndex = match[0].length === 0 ? start + 1 : end;
      if (found.length >= MAX_RESULTS) return found;
    }
  }
  return found;
}

async function runSearch() {
  clearTimeout(typingTimer);
  const token = ++searchToken;
  results = [];

  if (!query || !fs.hasFolder() || !state.tree) {
    renderResults();
    return;
  }

  const matcher = buildMatcher();
  if (matcher.error) {
    renderResults({ status: matcher.error, error: true });
    return;
  }

  const paths = collectPaths(state.tree).filter((path) => !fs.isBinaryPath(path));
  renderResults({ status: `Searching ${paths.length} file${paths.length === 1 ? '' : 's'}…` });

  const found = [];
  let total = 0;
  let skipped = 0;
  let truncated = false;

  await mapLimit(paths, READ_AT_ONCE, async (path) => {
    if (token !== searchToken || total >= MAX_RESULTS) return;
    let text = openTextOf(path);
    if (text === null) {
      try {
        // Ask how big it is first: a stray log file should not be pulled into memory whole.
        const { size } = await fs.stat(path);
        if (size > MAX_FILE_BYTES) {
          skipped += 1;
          return;
        }
        text = await fs.readText(path);
      } catch {
        return; // unreadable right now: leave it out rather than failing the whole search
      }
    }
    if (token !== searchToken) return;

    const matches = matchesIn(text, matcher.regex);
    if (!matches.length) return;
    const room = MAX_RESULTS - total;
    if (room <= 0) {
      truncated = true;
      return;
    }
    if (matches.length > room) truncated = true;
    total += Math.min(matches.length, room);
    found.push({ path, name: fs.baseName(path), matches: matches.slice(0, room) });
  });

  if (token !== searchToken) return; // a newer search has already started
  found.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  results = found;
  focusedRow = 0;
  renderResults({ truncated, skipped });
}

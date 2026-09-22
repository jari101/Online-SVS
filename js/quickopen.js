// js/quickopen.js — Ctrl+P: type a few letters of a file name and press Enter to open it.
//
// The letters do not have to be next to each other: "csty" finds "css/style.css", because a
// name matches when its letters appear in that order somewhere in the path. Matches in the
// file's own name beat matches in the folders above it, and short names beat long ones, so
// the file you meant is usually the first one in the list.
//
// It is built on the browser's own <dialog>, which brings the dimmed background, the focus
// trap and Escape-to-close with it.

import { state } from './state.js';
import * as fs from './fs/index.js';
import { openFile } from './editor.js';
import { icons, fileTypeClass } from './icons.js';
import { escapeHtml, el } from './dom.js';
import { toast } from './toast.js';

const MAX_SHOWN = 50;

let dialog = null;
let input = null;
let list = null;
let items = [];      // the paths currently listed
let selected = 0;

function ensureDialog() {
  if (dialog) return dialog;
  dialog = el('dialog', 'quick-open');
  dialog.setAttribute('aria-label', 'Go to file');
  dialog.innerHTML = `
    <input class="quick-input" type="text" spellcheck="false" autocomplete="off"
           placeholder="Go to file — type part of its name"
           aria-label="Go to file — type part of its name"
           role="combobox" aria-expanded="true" aria-controls="quick-list" aria-autocomplete="list">
    <ul class="quick-list" id="quick-list" role="listbox" aria-label="Files in this folder"></ul>
    <p class="quick-hint">Up and Down to choose · Enter to open · Esc to close</p>`;
  document.body.appendChild(dialog);

  input = dialog.querySelector('.quick-input');
  list = dialog.querySelector('.quick-list');

  input.addEventListener('input', () => refresh());
  input.addEventListener('keydown', onKeydown);
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.quick-item');
    if (item) choose(Number(item.dataset.index));
  });
  // Clicking the dimmed background closes it, like every other palette of this kind.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  return dialog;
}

/** Show the palette. Does nothing useful in scratch mode: there is only one file there. */
export function openQuickOpen() {
  if (!fs.hasFolder() || !state.tree) {
    toast('Ctrl+P looks through the files of an open folder. Open a folder first.', 'info', 4000);
    return;
  }
  const box = ensureDialog();
  if (box.open) {
    input.select();
    return;
  }
  input.value = '';
  refresh();
  box.showModal();
  input.focus();
}

/* ---------- The list ---------- */

function collectPaths(node, out = []) {
  if (!node) return out;
  if (node.kind === 'file') out.push(node.path);
  else for (const child of node.children) collectPaths(child, out);
  return out;
}

/**
 * Does every letter of `query` appear in `text`, in order? Returns where they landed and how
 * good the match feels, or null when a letter is missing.
 */
function fuzzy(query, text) {
  const lower = text.toLowerCase();
  const hits = [];
  let from = 0;
  let score = 0;
  let streak = 0;

  for (const letter of query) {
    const at = lower.indexOf(letter, from);
    if (at === -1) return null;
    if (at === from && hits.length) {
      streak += 1;
      score += 5 + streak;     // letters that follow one another are what you usually type
    } else {
      streak = 0;
      score += 1;
    }
    if (at === 0) score += 10;                          // the very start of the name
    else if (/[/._\- ]/.test(lower[at - 1])) score += 5; // the start of a word inside it
    hits.push(at);
    from = at + 1;
  }
  return { score: score - (text.length - query.length) * 0.05, hits };
}

/** Score one path. A match in the file's own name is worth more than one in its folders. */
function rank(query, path) {
  const name = fs.baseName(path);
  const inName = fuzzy(query, name);
  if (inName) return { score: inName.score + 100, nameHits: inName.hits, pathHits: null };
  const inPath = fuzzy(query, path);
  if (inPath) return { score: inPath.score, nameHits: null, pathHits: inPath.hits };
  return null;
}

function refresh() {
  const query = input.value.toLowerCase().replace(/\s+/g, '');
  const all = collectPaths(state.tree);

  let listed;
  if (!query) {
    // Nothing typed yet: offer the files you already have open, then the rest.
    const open = state.openFiles.filter((f) => !f.scratch).map((f) => f.path);
    const rest = all.filter((path) => !open.includes(path));
    listed = [...open.filter((path) => all.includes(path)), ...rest]
      .slice(0, MAX_SHOWN)
      .map((path) => ({ path, nameHits: null, pathHits: null }));
  } else {
    listed = all
      .map((path) => {
        const scored = rank(query, path);
        return scored && { path, ...scored };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
      .slice(0, MAX_SHOWN);
  }

  items = listed;
  selected = 0;
  renderList(query);
}

/** Wrap the matched letters of `text` in <mark>, leaving everything else as plain text. */
function highlight(text, hits) {
  if (!hits || !hits.length) return escapeHtml(text);
  let out = '';
  let at = 0;
  for (const index of hits) {
    out += escapeHtml(text.slice(at, index)) + `<mark>${escapeHtml(text[index])}</mark>`;
    at = index + 1;
  }
  return out + escapeHtml(text.slice(at));
}

function renderList(query) {
  list.innerHTML = '';
  if (!items.length) {
    const empty = el('li', 'quick-empty muted');
    empty.textContent = query ? `No file in "${state.folder.name}" matches that.` : `"${state.folder.name}" holds no files.`;
    list.appendChild(empty);
    input.removeAttribute('aria-activedescendant');
    return;
  }

  items.forEach((item, index) => {
    const name = fs.baseName(item.path);
    const dir = fs.parentOf(item.path);
    // A match against the whole path has to be split between the two halves shown: the
    // letters inside the folder part, and the rest counted from the start of the name.
    const offset = dir ? dir.length + 1 : 0;
    const dirHits = item.pathHits ? item.pathHits.filter((at) => at < dir.length) : null;
    const nameHits = item.nameHits
      || (item.pathHits ? item.pathHits.filter((at) => at >= offset).map((at) => at - offset) : null);
    const row = el('li', 'quick-item');
    row.id = `quick-item-${index}`;
    row.dataset.index = String(index);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === selected));
    if (index === selected) row.classList.add('selected');
    row.innerHTML = `
      <span class="tree-icon ${fileTypeClass(name)}">${icons.file}</span>
      <span class="quick-name">${highlight(name, nameHits)}</span>
      <span class="quick-dir">${highlight(dir, dirHits)}</span>`;
    list.appendChild(row);
  });
  select(selected);
}

function select(index) {
  if (!items.length) return;
  selected = (index + items.length) % items.length;
  for (const row of list.querySelectorAll('.quick-item')) {
    const isSelected = Number(row.dataset.index) === selected;
    row.classList.toggle('selected', isSelected);
    row.setAttribute('aria-selected', String(isSelected));
    if (isSelected) row.scrollIntoView({ block: 'nearest' });
  }
  input.setAttribute('aria-activedescendant', `quick-item-${selected}`);
}

function choose(index) {
  const item = items[index];
  if (!item) return;
  dialog.close();
  openFile(item.path).catch((err) => toast(`Unable to open ${item.path}: ${err.message}`, 'error'));
}

function onKeydown(e) {
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); select(selected + 1); break;
    case 'ArrowUp': e.preventDefault(); select(selected - 1); break;
    case 'Home': e.preventDefault(); select(0); break;
    case 'End': e.preventDefault(); select(items.length - 1); break;
    case 'Enter': e.preventDefault(); choose(selected); break;
    case 'Tab': e.preventDefault(); dialog.close(); break;
    default: break;
  }
}

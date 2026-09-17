// js/recent.js — remembers the folder you were working in, and the files you had open in it.
//
// The File System Access API gives out a "handle" for a folder you picked. A handle can be
// stored in the browser's own database and still points at the same folder tomorrow, so the
// app can offer "Reopen hello" instead of making you find it again — and once it is open,
// Ctrl+S writes back into that same hello as before.
//
// The handle is not a path and holds nothing we could read or send anywhere; it only works
// inside your browser, and Chrome asks your permission again on every visit, which is why
// the bar has a button rather than reopening by itself.

import { state, on } from './state.js';
import * as fs from './fs/index.js';
import { KEYS, readEntry, writeEntry, deleteEntry, verifyPermission } from './fs/handles.js';
import { openFilePositions } from './editor.js';
import { toast } from './toast.js';
import { $ } from './dom.js';

let record = null;       // { name, handle, tabs, activePath, savedAt }
let dismissed = false;   // the bar was closed by hand this session
let saveTimer = null;
let reopenFolder = null; // main.js hands us the function that adopts a folder

/** Set up the bar and start following which files are open. `reopen(backend, restore)`. */
export async function initRecent({ reopen }) {
  reopenFolder = reopen;

  $('btn-reopen').addEventListener('click', reopenNow);
  $('btn-reopen-forget').addEventListener('click', () => {
    const name = record?.name;
    forget();
    toast(`Forgot "${name}". It is only removed from this browser's memory — the folder itself is untouched.`, 'info', 4500);
  });
  $('btn-reopen-dismiss').addEventListener('click', () => {
    dismissed = true;
    renderBar();
  });

  if (fs.supportsNative) {
    const saved = await readEntry(KEYS.lastFolder);
    if (saved?.handle) record = saved;
  }

  on('mode', renderBar);
  on('folder', renderBar);
  on('tabs', scheduleSave);
  on('active', scheduleSave);
  window.addEventListener('pagehide', saveNow);
  renderBar();
}

/* ---------- Remembering ---------- */

/** Called when a folder is opened. Only a real folder on disk can be remembered. */
export function rememberFolder(backend) {
  const handle = backend?.handle;
  if (!handle) return; // the sample project and the read-only fallback have nothing to store
  record = { name: backend.name, handle, tabs: [], activePath: null, savedAt: Date.now() };
  dismissed = false;
  writeEntry(KEYS.lastFolder, record);
  renderBar();
}

/** Forget the remembered folder (the folder on your computer is not touched). */
export function forget() {
  record = null;
  deleteEntry(KEYS.lastFolder);
  renderBar();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

/** Store which files are open and where each cursor sits. */
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const handle = fs.folderHandle();
  if (!handle || !record) return;
  record = {
    ...record,
    name: state.folder?.name || record.name,
    handle,
    tabs: openFilePositions(),
    activePath: state.activePath,
    savedAt: Date.now(),
  };
  writeEntry(KEYS.lastFolder, record);
}

/* ---------- The bar under the title bar ---------- */

function renderBar() {
  const bar = $('reopen-bar');
  if (!bar) return;
  const remembered = Boolean(record?.handle);

  // The menu entry follows what is remembered, whatever the bar is doing — it is still the
  // way back to the folder once the bar has been dismissed.
  const menuItem = $('menu-reopen-folder');
  if (menuItem) {
    menuItem.hidden = !remembered;
    if (remembered) menuItem.textContent = `Reopen "${record.name}"`;
  }

  const show = remembered && !dismissed && state.mode !== 'folder';
  bar.hidden = !show;
  if (!show) return;

  $('reopen-name').textContent = record.name;
  const count = record.tabs?.length || 0;
  $('reopen-files').textContent = count ? `· ${count} file${count === 1 ? '' : 's'} open` : '';
  $('btn-reopen').title = `Open "${record.name}" again and save back into it`;
}

/** Show the bar again (used after a folder is closed). */
export function offerReopen() {
  dismissed = false;
  renderBar();
}

/**
 * Reopen the remembered folder. Chrome will only ask for permission during a real click,
 * which is why this runs straight from the button's handler.
 */
export async function reopenNow() {
  if (!record?.handle) return;
  const { handle, name } = record;

  if (!(await verifyPermission(handle, { request: true }))) {
    toast(`Permission to open "${name}" was not given, so nothing was opened.`, 'warning', 4500);
    return;
  }

  let backend;
  try {
    backend = fs.folderFromHandle(handle);
    await backend.tree(); // fails fast if the folder was moved, renamed or deleted
  } catch {
    toast(`"${name}" could not be opened. It may have been moved, renamed or deleted, so it has been forgotten.`, 'error');
    forget();
    return;
  }

  dismissed = true;
  renderBar();
  await reopenFolder(backend, { tabs: record.tabs || [], activePath: record.activePath || null });
}

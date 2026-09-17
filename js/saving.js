// js/saving.js — the two ways your work gets back to the place it came from.
//
// 1. The scratch file starts with no home: it belongs to no folder. The first Ctrl+S asks
//    where to put it, and the browser hands back a handle to that exact file. Every save
//    after that writes straight back to it — same folder, same name — and the tab shows the
//    real file name instead of "untitled". The handle is remembered between visits, so
//    tomorrow's Ctrl+S still lands in the same place without asking again.
//
// 2. A folder the browser cannot write to (Firefox, Safari, and the in-memory sample) is
//    packed back up as <folder>.zip, laid out exactly as it was. Unzip it over the original
//    and every file is back in the subfolder it came from.

import { state, emit, on } from './state.js';
import * as fs from './fs/index.js';
import { KEYS, readEntry, writeEntry, deleteEntry, verifyPermission } from './fs/handles.js';
import { zipFolder } from './fs/zip.js';
import { currentScratch } from './scratch.js';
import { saveAll, setScratchName, markNeedsExport } from './editor.js';
import { downloadText, downloadBlob } from './dom.js';
import { toast } from './toast.js';

/** Chrome, Edge, Opera and Brave can be asked "where should I put this file?". */
export const supportsSaveAs = typeof window.showSaveFilePicker === 'function';

let home = null; // { handle, name, language } — where the scratch file lives on disk

export function scratchHome() {
  return home;
}

/* ---------- The scratch file's home on disk ---------- */

/** Load the remembered home and keep the tab name in step with the chosen language. */
export async function initSaving() {
  if (supportsSaveAs) {
    const saved = await readEntry(KEYS.scratchFile);
    if (saved?.handle) home = saved;
  }
  // The scratch file changes language from the title bar. A home is one particular file with
  // one particular extension, so switching language lets go of it rather than writing C++
  // into something called main.py.
  on('scratch', (lang) => {
    if (!home) return;
    if (home.language === lang.id) setScratchName(home.name);
    else dropHome(`"${home.name}" is a ${home.language} file, so ${lang.name} starts fresh. Ctrl+S will ask where to save.`);
  });
}

function dropHome(message) {
  home = null;
  deleteEntry(KEYS.scratchFile);
  const entry = currentScratch();
  if (entry) setScratchName(`untitled.${entry.language.ext}`);
  if (message) toast(message, 'info', 5000);
}

async function pickLocation(entry) {
  try {
    return await window.showSaveFilePicker({
      suggestedName: entry.name,
      id: 'svs-scratch',
      types: [{
        description: `${entry.language.name} file`,
        accept: { 'text/plain': [`.${entry.language.ext}`] },
      }],
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return null; // the user closed the dialog
    throw err;
  }
}

async function writeHandle(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/**
 * Save the scratch file. The first time it asks where to put it; after that it writes back
 * to the same file. `pickNew` forces the question again ("Save As…").
 * Must be called from a click or key press: the browser only opens the dialog then.
 */
export async function saveScratch({ pickNew = false } = {}) {
  const entry = currentScratch();
  if (!entry) return;
  const text = entry.model.getValue();

  if (!supportsSaveAs) {
    // Firefox and Safari cannot be told where to put a file; the browser decides.
    downloadText(entry.name, text);
    toast(
      `Downloaded ${entry.name} to your Downloads folder — this browser cannot save to a folder you choose. ` +
      'The text is also kept in this browser, so a refresh does not lose it.',
      'info', 5500,
    );
    return;
  }

  let handle = pickNew ? null : home?.handle || null;
  if (handle && !(await verifyPermission(handle, { request: true }))) {
    toast(`Writing to ${home.name} was not allowed, so you will be asked where to put it.`, 'warning', 4000);
    handle = null;
  }

  const reused = Boolean(handle);
  if (!handle) {
    handle = await pickLocation(entry);
    if (!handle) return; // cancelled
  }

  await writeHandle(handle, text);
  home = { handle, name: handle.name, language: entry.language.id };
  await writeEntry(KEYS.scratchFile, home);
  setScratchName(handle.name);
  emit('saved', entry);
  toast(
    reused ? `Saved ${handle.name} back where it came from` : `Saved ${handle.name}. Ctrl+S now writes straight back to it.`,
    'success', reused ? 1800 : 4000,
  );
}

/** "Save As…" — always asks for a new place, and that place becomes the new home. */
export const saveScratchAs = () => saveScratch({ pickNew: true });

/* ---------- Packing a folder back up ---------- */

/**
 * Write every open tab into the folder, then download the whole folder as one zip named
 * after it. Unzipping it over the original folder puts every file back where it came from.
 */
export async function saveFolderZip() {
  if (!fs.hasFolder()) {
    toast('Open a folder first — there is nothing to pack up yet.', 'warning');
    return;
  }

  await saveAll(); // so the zip holds what you see, not what was last written
  const { name, files, dirs } = await fs.snapshot();
  if (!files.length) {
    toast(`"${name}" has no files to save.`, 'warning');
    return;
  }

  const { blob, name: zipName } = zipFolder(name, { files, dirs });
  downloadBlob(zipName, blob);
  markNeedsExport(false);

  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  if (state.folder?.kind === 'native') {
    toast(`Downloaded ${zipName} — a copy of "${name}" with all ${count}.`, 'success', 5000);
  } else {
    toast(`Downloaded ${zipName} (${count}). Unzip it over your "${name}" folder to put everything back.`, 'success', 7000);
  }
}

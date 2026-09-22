// js/drop.js — drag a folder or a .zip onto the window and it opens as your project.
//
// The quickest way in: no menu, no picker. While something is being dragged over the page an
// overlay says what will happen, so a drop is never a surprise.
//
// In Chrome, Edge, Opera and Brave a dropped item also comes with a *handle* to it, the same
// kind of thing the pickers give out: a dropped folder can then be saved back into like any
// other, and a dropped zip is written back into the very file you dropped. Elsewhere we get
// the old "entry" interface instead, which can be read but not written, so a folder opens
// read-only and a zip is downloaded again when you save it.

import { toast } from './toast.js';
import { $ } from './dom.js';

let openZip = null;
let openFolder = null;
let depth = 0; // dragenter/dragleave fire for every element passed over, so they are counted

/**
 * Start listening.
 * @param {Function} open        called with a dropped zip: (file, handle)
 * @param {Function} openDropped called with a dropped folder: ({ handle }) or ({ entry })
 */
export function initDrop({ open, openDropped }) {
  openZip = open;
  openFolder = openDropped;

  window.addEventListener('dragenter', (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    depth++;
    showOverlay(true);
  });

  window.addEventListener('dragover', (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault(); // without this the browser navigates to the file instead
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!draggingFiles(e)) return;
    // Leaving the window itself reports no element being entered. Counting alone can drift if
    // an enter is missed, and a dimmed screen that will not go away is worse than a missed
    // overlay — so that case clears it outright.
    if (e.relatedTarget === null) depth = 0;
    else depth = Math.max(0, depth - 1);
    if (!depth) showOverlay(false);
  });

  window.addEventListener('drop', onDrop);
}

/** Is a file being dragged (rather than selected text or a link)? */
function draggingFiles(e) {
  return [...(e.dataTransfer?.items || [])].some((item) => item.kind === 'file');
}

function showOverlay(visible) {
  const overlay = $('drop-overlay');
  if (overlay) overlay.hidden = !visible;
}

function onDrop(e) {
  if (!e.isTrusted) return; // a previewed page shares this origin and must not stage a drop
  const items = [...(e.dataTransfer?.items || [])].filter((item) => item.kind === 'file');
  if (!items.length) return;
  e.preventDefault();
  depth = 0;
  showOverlay(false);

  // The dropped data is emptied the moment this handler returns, so everything we need is
  // taken out of it now; the reading and unzipping happen in the promise below.
  const item = items[0];
  const file = item.getAsFile();
  const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
  const handle = typeof item.getAsFileSystemHandle === 'function'
    ? item.getAsFileSystemHandle().catch(() => null)
    : Promise.resolve(null);

  accept(file, handle, entry, items.length).catch((err) => {
    console.error(err);
    toast(err?.message || String(err), 'error');
  });
}

async function accept(file, handlePromise, entry, dropped) {
  const handle = await handlePromise;

  // A folder: open it as the project, writeable when the browser gave us a handle for it.
  if (handle?.kind === 'directory') {
    if (dropped > 1) toast(`Opening "${handle.name}" — only one folder can be open at a time.`, 'info', 4000);
    await openFolder({ handle });
    return;
  }
  if (entry?.isDirectory) {
    if (dropped > 1) toast(`Opening "${entry.name}" — only one folder can be open at a time.`, 'info', 4000);
    await openFolder({ entry });
    return;
  }
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) {
    toast(`"${file.name}" is not a .zip file. Drop a zip, or use Open Folder for a folder on your computer.`, 'warning', 5000);
    return;
  }
  if (dropped > 1) toast(`Opening "${file.name}" — only one zip can be open at a time.`, 'info', 4000);

  await openZip(file, handle && handle.kind === 'file' ? handle : null);
}

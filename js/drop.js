// js/drop.js — drag a .zip onto the window and it opens as a folder.
//
// The quickest way in: no menu, no picker, no permission dialog. While something is being
// dragged over the page an overlay says what will happen, so a drop is never a surprise.
//
// In Chrome, Edge, Opera and Brave a dropped file also comes with a *handle* to it, which is
// the same kind of thing the folder picker gives out — and that is what lets Save Folder write
// your edits back into the very zip you dropped. Elsewhere we only get a copy of the bytes, so
// Save Folder downloads a new zip instead.

import { toast } from './toast.js';
import { $ } from './dom.js';

let openZip = null;
let depth = 0; // dragenter/dragleave fire for every element passed over, so they are counted

/** Start listening. `open(file, handle)` is called with a dropped zip. */
export function initDrop({ open }) {
  openZip = open;

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
  const handle = typeof item.getAsFileSystemHandle === 'function'
    ? item.getAsFileSystemHandle().catch(() => null)
    : Promise.resolve(null);

  accept(file, handle, items.length).catch((err) => {
    console.error(err);
    toast(err?.message || String(err), 'error');
  });
}

async function accept(file, handlePromise, dropped) {
  const handle = await handlePromise;

  // A dropped folder arrives as a file with no type and no size. Say so plainly rather than
  // claiming it is a broken zip.
  if (handle?.kind === 'directory' || (file && !file.type && !file.size)) {
    toast(`"${file?.name || 'That'}" is a folder. Use Open Folder to open one — dropping works for .zip files.`, 'warning', 5000);
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

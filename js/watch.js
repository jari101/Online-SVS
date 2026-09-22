// js/watch.js — notices when a file you have open is changed by something else.
//
// You might edit the same file in VS Code, pull a change with git, or have a build tool
// rewrite it. The browser has no way to be told about that, so this asks: every three
// seconds it looks at the modification time of each open file, and only when that time has
// moved does it read the file to see what actually changed.
//
// What happens then depends on you:
//   - you have not touched the tab  → it quietly takes the new text, keeping your cursor,
//     your scroll position and your undo history
//   - you have unsaved changes      → a notification asks which version to keep, and nothing
//     is thrown away until you answer
//
// Only a real folder on the disk (Chrome, Edge, Opera, Brave) can change behind our back.
// A folder read from a zip or through the read-only fallback lives in this tab's memory,
// so there is nothing to watch and the timer stays off.

import { CONFIG } from './config.js';
import { state, on } from './state.js';
import * as fs from './fs/index.js';
import { reloadFile } from './editor.js';
import { toast } from './toast.js';

/** path -> last modification time we know about. A path in here is a path we are watching. */
const known = new Map();
/** path -> how many times in a row we failed to look at it (a deleted file fails for ever). */
const misses = new Map();
/** Paths with a question on screen, so it is asked once and not once every three seconds. */
const asking = new Set();

let timer = null;
let checking = false;
// Set when the browser withdraws access to the folder. Without it, every switch back to this
// tab would start the timer again and say so again.
let givenUp = false;

function watchable() {
  return !givenUp && state.mode === 'folder' && fs.hasFolder() && fs.current().kind === 'native';
}

/** The open tabs that live in the folder (not the scratch file, not a binary tab). */
function watchedFiles() {
  return state.openFiles.filter((f) => !f.scratch && f.kind === 'text');
}

export function initWatcher() {
  on('folder', () => {
    known.clear();
    misses.clear();
    asking.clear();
    givenUp = false; // a newly opened folder gets a fresh start
    schedule();
  });
  // A newly opened tab is measured straight away, so a change made a second later is noticed.
  on('tabs', () => {
    if (watchable()) seed();
  });
  // Our own save moves the modification time; that is not an outside change.
  on('saved', (entry) => {
    if (entry && !entry.scratch) remember(entry.path);
  });
  document.addEventListener('visibilitychange', schedule);
  schedule();
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!watchable()) return;
  timer = setInterval(() => {
    // Nothing on the screen can change while the tab is in the background, and the check
    // costs a disk read per file, so it waits until you come back.
    if (!document.hidden) check();
  }, CONFIG.watchInterval);
}

async function remember(path) {
  try {
    const { lastModified } = await fs.stat(path);
    known.set(path, lastModified);
    misses.delete(path);
  } catch {
    /* gone or not readable: the next check deals with it */
  }
}

/** Measure any open file we are not watching yet, without reacting to what we find. */
async function seed() {
  for (const file of watchedFiles()) {
    if (!known.has(file.path)) await remember(file.path);
  }
}

/** Ask the tests (and the console) to look right now instead of waiting for the timer. */
export async function checkNow() {
  await check();
}

async function check() {
  if (checking || !watchable()) return;
  checking = true;
  try {
    for (const file of watchedFiles()) {
      if (asking.has(file.path)) continue;
      await checkOne(file);
      if (!watchable()) return; // the folder was closed while we were reading
    }
  } finally {
    checking = false;
  }
}

async function checkOne(file) {
  let stamp;
  try {
    stamp = (await fs.stat(file.path)).lastModified;
  } catch (err) {
    if (err && err.name === 'NotAllowedError') {
      // Permission for the whole folder is gone; there is nothing left to watch.
      givenUp = true;
      clearInterval(timer);
      timer = null;
      toast(`This browser has stopped allowing access to "${state.folder.name}", so changes made outside the editor are no longer noticed.`, 'warning', 6000);
      return;
    }
    const count = (misses.get(file.path) || 0) + 1;
    misses.set(file.path, count);
    if (count === 2) {
      known.delete(file.path); // stop looking, and say so once
      toast(`"${file.name}" is no longer in the folder. The tab is still here, so Ctrl+S writes it back.`, 'warning', 6000);
    }
    return;
  }
  misses.delete(file.path);

  const before = known.get(file.path);
  if (before === undefined) {
    known.set(file.path, stamp); // first sighting: this is the version we started from
    return;
  }
  if (stamp === before) return;

  let text;
  try {
    text = await fs.readText(file.path);
  } catch {
    // Being written to right now. The time is deliberately not stored, so the next check
    // looks again and sees the finished file.
    return;
  }
  if (!state.openFiles.includes(file) || file.model.isDisposed()) return;

  // Same text, new time: our own save, or a tool that rewrote the file without changing it.
  if (file.model.getValue() === text) {
    known.set(file.path, stamp);
    if (!file.dirty) reloadFile(file.path, text);
    return;
  }

  if (!file.dirty) {
    known.set(file.path, stamp);
    reloadFile(file.path, text);
    toast(`"${file.name}" changed outside the editor, so the tab was updated.`, 'info', 3000);
    return;
  }

  // Unsaved work is never overwritten without an answer. The new time is not stored until
  // that answer comes, so the question is asked about the newest version there is.
  asking.add(file.path);
  toast(
    `"${file.name}" changed outside the editor, but you have unsaved changes in it. Which version should stay?`,
    'warning',
    0,
    {
      actions: [
        {
          label: 'Keep mine',
          onClick: () => {
            asking.delete(file.path);
            known.set(file.path, stamp); // answered: do not ask about this change again
            toast(`Kept your version of "${file.name}". Ctrl+S overwrites what is on the disk.`, 'info', 3500);
          },
        },
        {
          label: 'Load theirs',
          primary: true,
          onClick: () => {
            asking.delete(file.path);
            known.set(file.path, stamp);
            if (reloadFile(file.path, text)) toast(`"${file.name}" reloaded from the disk.`, 'info', 2500);
          },
        },
      ],
      // Closed with the × instead of answered: nothing is touched, and this particular
      // change is not asked about again — but the next one still is.
      onDismiss: () => {
        asking.delete(file.path);
        known.set(file.path, stamp);
      },
    },
  );
}

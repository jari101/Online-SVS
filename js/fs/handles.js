// js/fs/handles.js — remembers folders and files between visits.
//
// The File System Access API hands out "handles": small objects that point at a real folder
// or file on your computer. They can be stored in IndexedDB and still work after a reload,
// which is what lets the app offer "Reopen hello" instead of making you pick it again.
// The handle is not a path: it stays inside your browser and tells us nothing we could send
// anywhere. Permission is asked again on every visit, and only when you click.
//
// Everything here fails softly. Remembering is a convenience, so a browser without
// IndexedDB (or a private window that blocks it) simply never remembers anything.

const DB_NAME = 'svs-handles';
const STORE = 'kv';

/** Keys used in the store. */
export const KEYS = {
  lastFolder: 'last-folder',
  scratchFile: 'scratch-file',
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null); // no IndexedDB at all
      return;
    }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Run one transaction and resolve to its result, or null when anything goes wrong. */
async function transact(mode, run) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let result = null;
    let tx;
    try {
      tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      if (request) request.onsuccess = () => { result = request.result; };
    } catch {
      resolve(null); // e.g. a value the browser cannot store
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

export const readEntry = (key) => transact('readonly', (store) => store.get(key));
export const writeEntry = (key, value) => transact('readwrite', (store) => store.put(value, key));
export const deleteEntry = (key) => transact('readwrite', (store) => store.delete(key));

/**
 * Is this handle still usable?
 * `request: true` may show the browser's permission prompt, which Chrome only allows
 * during a click or key press — so only pass it from inside an event handler.
 */
export async function verifyPermission(handle, { request = false, mode = 'readwrite' } = {}) {
  if (!handle || typeof handle.queryPermission !== 'function') return false;
  const options = { mode };
  try {
    if (await handle.queryPermission(options) === 'granted') return true;
    if (!request) return false;
    return await handle.requestPermission(options) === 'granted';
  } catch {
    return false; // the entry the handle pointed at is gone
  }
}

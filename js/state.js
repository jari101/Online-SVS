// js/state.js — one shared object that describes what the app is doing right now,
// plus a tiny "event bus" so modules can react to changes without importing each other.

export const state = {
  mode: 'scratch',        // 'scratch' (single untitled file) or 'folder' (a folder from the PC is open)
  folder: null,           // { name, kind: 'native' | 'memory', readOnly, sample } when a folder is open
  tree: null,             // folder tree: { name, path, kind: 'dir', children: [...] }
  openFiles: [],          // tabs: { path, name, kind: 'text' | 'binary', model, dirty, savedVersion, viewState, scratch?, language? }
  activePath: null,       // path of the file shown in the editor
  sidebarView: 'explorer',
  settings: {
    fontFamily: 'default',
    fontSize: 14,
    tabSize: 4,
    wordWrap: false,
    minimap: true,
  },
  stdin: '',              // text of the Input tab (sent to programs in Phase 3)
  live: { status: 'off', errors: 0 },   // 'off' | 'on' | 'paused' (Phase 2)
};

const listeners = new Map();

/** Subscribe to an event. Returns a function that unsubscribes. */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

/** Fire an event. Every listener runs; one failing listener does not stop the others. */
export function emit(event, data) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(data);
    } catch (err) {
      console.error(`Listener for "${event}" failed:`, err);
    }
  }
}

/** The tab that is currently shown, or null. */
export function activeFile() {
  return state.openFiles.find((f) => f.path === state.activePath) || null;
}

/** True when any real file (not the scratch file) has unsaved changes. */
export function hasDirtyFiles() {
  return state.openFiles.some((f) => f.dirty && !f.scratch);
}

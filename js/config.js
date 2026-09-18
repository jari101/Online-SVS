// js/config.js — the few knobs that decide where things load from and how the app behaves.
// `window.SVS_*` overrides exist so the automated tests can point at local copies
// (the test sandbox cannot reach the internet). Production never sets them.

const MONACO_VERSION = '0.52.2';
const PYODIDE_VERSION = '314.0.7';

export const CONFIG = {
  appName: 'Online SVS',

  // Monaco (the VS Code editor) is loaded from the jsDelivr npm mirror.
  monacoVersion: MONACO_VERSION,
  monacoBase: window.SVS_MONACO_BASE || `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min`,

  // Pyodide is CPython compiled to WebAssembly: it runs Python inside this browser tab,
  // so no server is involved and your code never leaves the machine. It is about 12 MB and
  // is downloaded the first time you run Python, then kept in the browser's cache.
  pyodideVersion: PYODIDE_VERSION,
  pyodideBase: window.SVS_PYODIDE_BASE || `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,

  // The code runner for languages a browser cannot run by itself: C, C++, Java, C#, Go,
  // Rust and the rest. There is no default any more — the free public Piston service closed
  // to the public on 15 February 2026 — so this is empty until you point Settings at a
  // Piston of your own. See the README for how to start one.
  defaultRunnerUrl: window.SVS_PISTON_URL || '',

  // Folder names the explorer never reads (they are huge and never part of a website).
  ignoredNames: ['node_modules', '.git', 'dist', 'build', '.cache', '.DS_Store', 'Thumbs.db'],

  // Language used for a brand-new scratch file.
  defaultLanguage: 'cpp',

  // localStorage keys. Only your own browser can read these; nothing goes to a server.
  scratchKey: 'svs.scratch',
  settingsKey: 'svs.settings',

  // Milliseconds of typing silence before the live server refreshes (Phase 2).
  liveRefreshDelay: 750,
};

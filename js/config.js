// js/config.js — the few knobs that decide where things load from and how the app behaves.
// `window.SVS_*` overrides exist so the automated tests can point at local copies
// (the test sandbox cannot reach the internet). Production never sets them.

const MONACO_VERSION = '0.52.2';

export const CONFIG = {
  appName: 'Online SVS',

  // Monaco (the VS Code editor) is loaded from the jsDelivr npm mirror.
  monacoVersion: MONACO_VERSION,
  monacoBase: window.SVS_MONACO_BASE || `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min`,

  // Piston runs the code (Phase 3). Point this at your own Piston if the public one is blocked.
  pistonUrl: window.SVS_PISTON_URL || 'https://emkc.org/api/v2/piston',

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

// js/statusbar.js — the blue bar at the bottom: live-server state, folder, cursor position,
// indentation, language and font.

import { state, on, emit, activeFile } from './state.js';
import { getMonaco } from './editor.js';
import { fontById } from './fonts.js';
import { languageForPath, needsServer } from './languages.js';
import { serverRunner } from './runners/piston.js';
import { showPanelTab } from './panel.js';
import { showSidebarView } from './layout.js';
import { $ } from './dom.js';

export function initStatusBar() {
  const cursor = $('status-cursor');
  const indent = $('status-indent');
  const language = $('status-language');
  const font = $('status-font');
  const folder = $('status-folder');
  const live = $('status-live');
  const liveText = $('status-live-text');
  const runner = $('status-runner');
  const runnerText = $('status-runner-text');

  on('cursor', (p) => {
    cursor.textContent = `Ln ${p.lineNumber}, Col ${p.column}`;
  });

  const updateLanguage = () => {
    const file = activeFile();
    if (!file) language.textContent = '';
    else if (file.model) language.textContent = languageLabel(file.model);
    else language.textContent = 'Binary';
  };
  on('active', updateLanguage);
  on('tabs', updateLanguage);

  // A quiet standing reminder for the languages that cannot run until a runner is set up.
  // The Settings panel opens by itself only the first time; after that, this is the nudge.
  const updateRunner = () => {
    const lang = languageOfActiveFile();
    const missing = Boolean(lang && needsServer(lang) && !serverRunner());
    runner.hidden = !missing;
    if (!missing) return;
    runnerText.textContent = `${lang.name} needs a code runner`;
    runner.title = `${lang.name} has to be compiled, so it cannot run inside your browser. `
      + 'Click to set up a code runner in Settings.';
  };
  on('active', updateRunner);
  on('tabs', updateRunner);
  on('scratch', updateRunner);
  on('runner-changed', updateRunner);
  updateRunner();
  runner.addEventListener('click', () => {
    showSidebarView('settings');
    emit('focus-runner-setting');
  });

  const updateSettings = () => {
    indent.textContent = `Spaces: ${state.settings.tabSize}`;
    font.textContent = fontById(state.settings.fontFamily).label.replace(/\s*\(.*\)$/, '');
  };
  on('settings', updateSettings);
  updateSettings();

  const updateFolder = () => {
    const app = $('app');
    if (state.folder) {
      let note = '';
      if (state.folder.readOnly) note = ' (read-only)';
      else if (state.folder.sample) note = ' (sample, in memory)';
      // Loud on purpose: these edits exist only in the editor until the folder is saved out.
      if (state.folder.needsExport) note += ' · not on your disk yet';
      folder.textContent = state.folder.name + note;
      folder.title = state.folder.kind === 'native'
        ? `Saving writes into "${state.folder.name}" on your disk. Click to download a zip copy of it.`
        : `This browser cannot write to "${state.folder.name}". Click to download ${state.folder.name}.zip and unzip it over the original.`;
      folder.classList.toggle('warn', Boolean(state.folder.needsExport));
      app.classList.toggle('folder-readonly', Boolean(state.folder.readOnly));
    } else {
      folder.textContent = 'No folder open · scratch file';
      folder.title = 'Click to open a folder from your computer.';
      folder.classList.remove('warn');
      app.classList.remove('folder-readonly');
    }
  };
  on('folder', updateFolder);
  updateFolder();

  const updateLive = () => {
    const { status, errors } = state.live;
    let text = 'Live: off';
    let title = 'The live server is off. Click to start it.';
    if (status === 'starting') {
      text = 'Live: starting…';
      title = 'The live server is starting.';
    } else if (status === 'on') {
      text = 'Live: on';
      title = 'The live server is running. Click to stop it.';
    } else if (status === 'paused') {
      text = `Live: paused · ${errors} error${errors === 1 ? '' : 's'}`;
      title = 'The preview will refresh once the errors are fixed. Click to see them.';
    }
    liveText.textContent = text;
    live.title = title;
    live.classList.toggle('warn', status === 'paused');
  };
  on('live', updateLive);
  updateLive();

  folder.addEventListener('click', () => emit('command', state.folder ? 'save-folder' : 'open-folder'));
  indent.addEventListener('click', () => showSidebarView('settings'));
  font.addEventListener('click', () => showSidebarView('settings'));
  live.addEventListener('click', () => {
    if (state.live.status === 'paused') showPanelTab('problems');
    else emit('command', 'toggle-live');
  });
}

/** The language of whatever is open: the scratch file carries its own, a real file goes by name. */
function languageOfActiveFile() {
  const file = activeFile();
  if (!file || file.kind !== 'text') return null;
  return file.scratch ? file.language : languageForPath(file.path);
}

/** "javascript" -> "JavaScript", using Monaco's own list of language names. */
function languageLabel(model) {
  const id = model.getLanguageId();
  const definition = getMonaco()?.languages.getLanguages().find((l) => l.id === id);
  return definition?.aliases?.[0] || id;
}

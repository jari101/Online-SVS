// js/statusbar.js — the blue bar at the bottom: live-server state, folder, cursor position,
// indentation, language and font.

import { state, on, emit, activeFile } from './state.js';
import { getMonaco } from './editor.js';
import { fontById } from './fonts.js';
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
      folder.textContent = state.folder.name + note;
      app.classList.toggle('folder-readonly', Boolean(state.folder.readOnly));
    } else {
      folder.textContent = 'No folder open · scratch file';
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

  indent.addEventListener('click', () => showSidebarView('settings'));
  font.addEventListener('click', () => showSidebarView('settings'));
  live.addEventListener('click', () => {
    if (state.live.status === 'paused') showPanelTab('problems');
    else emit('command', 'toggle-live');
  });
}

/** "javascript" -> "JavaScript", using Monaco's own list of language names. */
function languageLabel(model) {
  const id = model.getLanguageId();
  const definition = getMonaco()?.languages.getLanguages().find((l) => l.id === id);
  return definition?.aliases?.[0] || id;
}

// js/statusbar.js — the blue bar at the bottom: live-server state, folder, cursor position,
// indentation, language and font.

import { state, on, activeFile } from './state.js';
import { getMonaco } from './editor.js';
import { fontById } from './fonts.js';
import { showPanelTab } from './panel.js';
import { showSidebarView } from './layout.js';

const $ = (id) => document.getElementById(id);

export function initStatusBar() {
  const cursor = $('status-cursor');
  const indent = $('status-indent');
  const language = $('status-language');
  const font = $('status-font');
  const folder = $('status-folder');
  const live = $('status-live');

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

  for (const item of [indent, font]) {
    item.classList.add('clickable');
    item.addEventListener('click', () => showSidebarView('settings'));
  }
  live.classList.add('clickable');
  live.addEventListener('click', () => showPanelTab('problems'));
}

/** "javascript" -> "JavaScript", using Monaco's own list of language names. */
function languageLabel(model) {
  const id = model.getLanguageId();
  const definition = getMonaco()?.languages.getLanguages().find((l) => l.id === id);
  return definition?.aliases?.[0] || id;
}

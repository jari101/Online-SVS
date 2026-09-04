// js/settings.js — the Settings view (font, font size, tab size, word wrap, minimap),
// remembered in this browser's localStorage and applied to the editor straight away.

import { CONFIG } from './config.js';
import { FONTS, fontById, ensureFontLoaded } from './fonts.js';
import { state, emit } from './state.js';
import { updateEditorOptions, applyModelOptionsToAll, getMonaco } from './editor.js';
import { escapeHtml } from './dom.js';

const DEFAULTS = { fontFamily: 'default', fontSize: 14, tabSize: 4, wordWrap: false, minimap: true };

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(CONFIG.settingsKey) || '{}');
  } catch {
    saved = {};
  }
  Object.assign(state.settings, DEFAULTS, saved);
  // Never trust stored values blindly: keep them in a range the editor can handle.
  if (!FONTS.some((f) => f.id === state.settings.fontFamily)) state.settings.fontFamily = 'default';
  state.settings.fontSize = clamp(Number(state.settings.fontSize) || 14, 8, 32);
  state.settings.tabSize = [2, 4, 8].includes(Number(state.settings.tabSize)) ? Number(state.settings.tabSize) : 4;
  state.settings.wordWrap = Boolean(state.settings.wordWrap);
  state.settings.minimap = Boolean(state.settings.minimap);
}

function saveSettings() {
  try {
    localStorage.setItem(CONFIG.settingsKey, JSON.stringify(state.settings));
  } catch (err) {
    console.warn('Could not remember settings:', err);
  }
}

export function updateSetting(key, value) {
  state.settings[key] = value;
  saveSettings();
  applySettings();
  emit('settings', state.settings);
}

/** Push the current settings into Monaco. */
export function applySettings() {
  const s = state.settings;
  const font = fontById(s.fontFamily);
  updateEditorOptions({
    fontSize: s.fontSize,
    fontFamily: font.family,
    fontLigatures: font.ligatures,
    wordWrap: s.wordWrap ? 'on' : 'off',
    minimap: { enabled: s.minimap },
  });
  applyModelOptionsToAll();
  // A downloaded font arrives a moment later; until then the editor uses the fallback
  // (Consolas/Menlo). Once it is in, Monaco must re-measure the character widths.
  ensureFontLoaded(font).then(() => getMonaco()?.editor.remeasureFonts());
}

export function renderSettings(container) {
  const s = state.settings;
  const fontOptions = FONTS.map(
    (f) => `<option value="${f.id}" ${f.id === s.fontFamily ? 'selected' : ''}>${escapeHtml(f.label)}</option>`,
  ).join('');
  const tabOptions = [2, 4, 8].map(
    (n) => `<option value="${n}" ${n === s.tabSize ? 'selected' : ''}>${n} spaces</option>`,
  ).join('');

  container.innerHTML = `
    <div class="sidebar-title">Settings</div>
    <form class="settings-form" id="settings-form">
      <div class="setting">
        <label for="setting-font">Editor font</label>
        <select id="setting-font" name="fontFamily">${fontOptions}</select>
        <span class="hint">Fira Code, JetBrains Mono and Cascadia Code are downloaded the first time you pick them (needs internet).</span>
      </div>
      <div class="setting">
        <label for="setting-font-size">Font size</label>
        <input id="setting-font-size" name="fontSize" type="number" min="8" max="32" value="${s.fontSize}">
        <span class="hint">Tip: hold Ctrl and scroll inside the editor to zoom.</span>
      </div>
      <div class="setting">
        <label for="setting-tab-size">Tab size</label>
        <select id="setting-tab-size" name="tabSize">${tabOptions}</select>
      </div>
      <div class="setting setting-inline">
        <input id="setting-wrap" name="wordWrap" type="checkbox" ${s.wordWrap ? 'checked' : ''}>
        <label for="setting-wrap">Word wrap</label>
      </div>
      <div class="setting setting-inline">
        <input id="setting-minimap" name="minimap" type="checkbox" ${s.minimap ? 'checked' : ''}>
        <label for="setting-minimap">Show minimap</label>
      </div>
      <p class="settings-note">Settings and the scratch file are kept in this browser only (localStorage). Nothing is sent to a server.</p>
    </form>`;

  const form = container.querySelector('#settings-form');
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('change', (e) => {
    const input = e.target;
    const key = input.name;
    if (!key) return;
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (key === 'fontSize' || key === 'tabSize') value = Number(input.value);
    else value = input.value;
    if (key === 'fontSize') {
      value = clamp(value || 14, 8, 32);
      input.value = value;
    }
    updateSetting(key, value);
  });
}

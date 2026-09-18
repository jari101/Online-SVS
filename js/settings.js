// js/settings.js — the Settings view: how the editor looks, and where code that cannot run
// inside the browser is sent instead. Everything here is remembered in this browser's
// localStorage and applied straight away.

import { CONFIG } from './config.js';
import { FONTS, fontById, ensureFontLoaded } from './fonts.js';
import { state, on, emit } from './state.js';
import { updateEditorOptions, applyModelOptionsToAll, getMonaco } from './editor.js';
import { LANGUAGES, runsInBrowser, needsServer } from './languages.js';
import { forgetRuntimes, testRunner } from './runners/piston.js';
import { escapeHtml, clamp, joinNames } from './dom.js';

const DEFAULTS = {
  fontFamily: 'default',
  fontSize: 14,
  tabSize: 4,
  wordWrap: false,
  minimap: true,
  runnerUrl: '',
  runnerKey: '',
};

let testController = null;   // the "Test connection" request that is still in the air


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
  state.settings.runnerUrl = cleanRunnerUrl(state.settings.runnerUrl);
  state.settings.runnerKey = typeof state.settings.runnerKey === 'string' ? state.settings.runnerKey.trim() : '';
  if (!state.settings.runnerUrl && CONFIG.defaultRunnerUrl) {
    state.settings.runnerUrl = cleanRunnerUrl(CONFIG.defaultRunnerUrl);
  }
}

/** Only http(s) addresses, with any trailing slashes taken off. */
function cleanRunnerUrl(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return /^https?:\/\//i.test(text) ? text : '';
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
  if (key === 'runnerUrl' || key === 'runnerKey') {
    // A different server may run a different set of languages, so ask it again next time.
    forgetRuntimes();
    emit('runner-changed', state.settings.runnerUrl);
  }
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

      <h3 class="settings-heading">Code runner</h3>
      <p class="settings-lead">
        ${escapeHtml(browserList())} run right here in your browser — no setup, no internet needed
        once they are cached. ${escapeHtml(serverList())} have to be compiled, so they are sent to a
        Piston server that you run.
      </p>
      <div class="setting" id="setting-runner">
        <label for="setting-runner-url">Address of your Piston</label>
        <input id="setting-runner-url" name="runnerUrl" type="url" spellcheck="false" autocomplete="off"
               placeholder="https://piston.example.com/api/v2/piston" value="${escapeHtml(s.runnerUrl)}">
        <span class="hint">Leave this empty to use only the languages that run in your browser.</span>
      </div>
      <div class="setting">
        <label for="setting-runner-key">Key <span class="label-note">(only if your server asks for one)</span></label>
        <input id="setting-runner-key" name="runnerKey" type="password" spellcheck="false" autocomplete="off"
               placeholder="usually not needed" value="${escapeHtml(s.runnerKey)}">
        <span class="hint">Kept in this browser's localStorage, the same as every other setting here.</span>
      </div>
      <div class="setting">
        <button type="button" class="btn btn-secondary" id="btn-test-runner">Test connection</button>
        <span class="hint" id="runner-status" role="status" aria-live="polite"></span>
      </div>
      <p class="settings-note">
        The free public Piston closed to the public on 15 February 2026, so there is no address
        built in any more. The README shows how to start your own with Docker.
      </p>

      <p class="settings-note">Settings and the scratch file are kept in this browser only (localStorage). Nothing is sent to a server.</p>
    </form>`;

  const form = container.querySelector('#settings-form');
  form.addEventListener('submit', (e) => e.preventDefault());
  container.querySelector('#btn-test-runner').addEventListener('click', () => runTest(container));
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
    if (key === 'runnerUrl') {
      const typed = String(value).trim();
      const address = cleanRunnerUrl(typed);
      if (typed && !address) {
        // Say what is wrong and leave the text alone: quietly wiping the field would lose
        // the address and teach nothing about why it was not accepted.
        setRunnerStatus(container, 'The address should start with http:// or https://', 'error');
        return;
      }
      input.value = address;
      value = address;
      setRunnerStatus(container, '');
    }
    if (key === 'runnerKey') {
      value = String(value).trim();
      setRunnerStatus(container, '');
    }
    updateSetting(key, value);
  });
}

/** The two halves of the language list, for the sentence above the Code runner fields. */
function browserList() {
  return joinNames(LANGUAGES.filter(runsInBrowser).map((l) => l.name));
}

function serverList() {
  return joinNames(LANGUAGES.filter(needsServer).map((l) => l.name).slice(0, 4).concat('the rest'));
}

function setRunnerStatus(container, message, kind = '') {
  const status = container.querySelector('#runner-status');
  if (!status) return;
  status.textContent = message;
  status.className = `hint ${kind}`;
}

/** Ask the address in the form whether it is really a Piston, and say so in plain words. */
async function runTest(container) {
  const url = container.querySelector('#setting-runner-url').value;
  const key = container.querySelector('#setting-runner-key').value;
  const button = container.querySelector('#btn-test-runner');

  testController?.abort();
  testController = new AbortController();
  const mine = testController;

  button.disabled = true;
  setRunnerStatus(container, 'Trying…');
  try {
    const result = await testRunner(url, key, mine.signal);
    if (mine !== testController) return; // a newer test started while we waited
    setRunnerStatus(container, result.message, result.ok ? 'success' : 'error');
    if (result.ok) {
      // It works, so keep it even if the field was never blurred.
      updateSetting('runnerUrl', cleanRunnerUrl(url));
      updateSetting('runnerKey', String(key).trim());
    }
  } catch (err) {
    if (err.name !== 'AbortError') setRunnerStatus(container, err.message, 'error');
  } finally {
    if (mine === testController) {
      testController = null;
      button.disabled = false;
    }
  }
}

// The Run button sends you here when a language has nowhere to run. Put the cursor in the
// field that fixes it, and make it obvious which one that is.
on('focus-runner-setting', () => {
  const field = document.getElementById('setting-runner');
  const input = document.getElementById('setting-runner-url');
  if (!field || !input) return;
  input.focus();
  field.classList.remove('flash');
  void field.offsetWidth; // restart the animation even if it is already running
  field.classList.add('flash');
});

// js/scratch.js — the OnlineGDB-style mode: no folder, just one "untitled" file with a
// language dropdown. Its text is remembered in this browser's localStorage so a refresh
// does not lose it. Nothing is sent anywhere.

import { CONFIG } from './config.js';
import { state, on, emit } from './state.js';
import { LANGUAGES, findLanguage, runsInBrowser, needsServer } from './languages.js';
import { serverRunner, knownRuntimes } from './runners/piston.js';
import { openScratch, replaceScratchModel, removeScratch } from './editor.js';
import { showSidebarView } from './layout.js';

let selectEl = null;
let saveTimer = null;

// Choosing a language that has nowhere to run opens Settings — but only the first time in a
// session. After that the status bar carries the reminder, so switching languages while you
// are reading or writing code does not keep throwing you into Settings.
let offeredSettings = false;

function readSaved() {
  try {
    const raw = localStorage.getItem(CONFIG.scratchKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSaved(data) {
  try {
    localStorage.setItem(CONFIG.scratchKey, JSON.stringify(data));
  } catch (err) {
    console.warn('Could not remember the scratch file:', err);
  }
}

/**
 * Say in the dropdown which languages can actually be run right now. They all stay
 * selectable: you can write and save code in any of them, and HTML is previewed with
 * Go Live rather than run.
 */
export function refreshLanguageAvailability() {
  if (!selectEl) return;
  const runner = serverRunner();
  const runtimes = knownRuntimes();
  for (const option of selectEl.options) {
    const lang = findLanguage(option.value);
    if (!lang) continue;
    option.textContent = lang.name + availabilityNote(lang, runner, runtimes);
  }
}

function availabilityNote(lang, runner, runtimes) {
  if (runsInBrowser(lang)) return ' — runs in your browser';
  if (!needsServer(lang)) return '';               // HTML: previewed, never run
  if (!runner) return ' — needs a code runner';
  // We only know what the runner offers once it has been asked, which happens on the first run.
  if (runtimes && !runtimes.has(lang.piston)) return ' — your runner does not have it';
  return '';
}

export function currentScratch() {
  return state.openFiles.find((f) => f.scratch) || null;
}

export function saveScratchNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const entry = currentScratch();
  if (!entry) return;
  writeSaved({ language: entry.language.id, content: entry.model.getValue() });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveScratchNow, 300);
}

/** Fill the language dropdown and start listening for edits. */
export function initScratch(select) {
  selectEl = select;
  for (const lang of LANGUAGES) {
    const option = document.createElement('option');
    option.value = lang.id;
    option.textContent = lang.name;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    const lang = findLanguage(select.value);
    setScratchLanguage(lang);
    offerRunnerSetup(lang);
  });
  refreshLanguageAvailability();
  on('runner-changed', refreshLanguageAvailability);
  on('content', (entry) => {
    if (entry.scratch) scheduleSave();
  });
  window.addEventListener('pagehide', saveScratchNow);
}

/** Create the scratch tab from what was remembered (or the starter program). */
export function enterScratchMode() {
  const saved = readSaved();
  const lang = findLanguage(saved?.language) || findLanguage(CONFIG.defaultLanguage);
  const content = typeof saved?.content === 'string' ? saved.content : lang.template;
  openScratch(lang, content);
  selectEl.value = lang.id;
  emit('scratch', lang);
}

/** Remove the scratch tab (a folder is being opened). Its text stays remembered. */
export function leaveScratchMode() {
  saveScratchNow();
  removeScratch();
}

/** Picking a language with nowhere to run takes you to the one place that fixes it. */
function offerRunnerSetup(lang) {
  if (!lang || !needsServer(lang) || serverRunner()) return;
  emit('runner-needed', lang);
  if (offeredSettings) return;
  offeredSettings = true;
  showSidebarView('settings');
  emit('focus-runner-setting');
}

export function setScratchLanguage(lang) {
  const entry = currentScratch();
  if (!entry || !lang || entry.language.id === lang.id) return;
  const text = entry.model.getValue();
  // Only replace the text with the new starter program when you have not written anything yet.
  const untouched = text.trim() === '' || text.trim() === entry.language.template.trim();
  replaceScratchModel(lang, untouched ? lang.template : text);
  selectEl.value = lang.id;
  saveScratchNow();
  emit('scratch', lang);
}

// js/scratch.js — the OnlineGDB-style mode: no folder, just one "untitled" file with a
// language dropdown. Its text is remembered in this browser's localStorage so a refresh
// does not lose it. Nothing is sent anywhere.

import { CONFIG } from './config.js';
import { state, on, emit } from './state.js';
import { LANGUAGES, findLanguage } from './languages.js';
import { openScratch, replaceScratchModel, removeScratch } from './editor.js';

let selectEl = null;
let saveTimer = null;

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
  select.addEventListener('change', () => setScratchLanguage(findLanguage(select.value)));
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

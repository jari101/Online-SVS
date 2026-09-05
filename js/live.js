// js/live.js — the Live Server, seen from the IDE side.
//
// How it works: sw.js (a Service Worker) answers every request for <site>/live/... from the
// browser's Cache API. This module keeps that cache in step with your files:
//   - Go Live: register the worker, copy every file of the folder into the cache, open the preview.
//   - While you type: 750 ms after the last keystroke, if Monaco reports no errors, copy the
//     changed files into the cache and tell every preview page to reload (a CSS-only change
//     just swaps the stylesheet). With errors, the status bar shows "paused" until they are fixed.
//   - Stop: empty the cache and hide the preview.

import { CONFIG } from './config.js';
import { state, on, emit } from './state.js';
import * as fs from './fs/index.js';
import { mimeFor } from './fs/util.js';
import { getMonaco } from './editor.js';
import { errorCount, collectProblems } from './panel.js';
import { togglePreview } from './layout.js';
import { toast } from './toast.js';
import { confirmDialog } from './dialog.js';
import { $ } from './dom.js';

const CACHE_NAME = 'svs-live-v1';
const CHANNEL_NAME = 'svs-live';
const CONSENT_KEY = 'svs.liveConsent';

let liveBase = null;        // absolute URL of ".../live/"
let channel = null;         // BroadcastChannel shared with the preview pages
let syncTimer = null;
const pending = new Set();  // files changed since the last sync
const synced = new Set();   // files currently in the cache

let frame;
let addressEl;
let emptyEl;
let openLink;
let liveButton;
let liveLabel;

export function isLive() {
  return state.live.status === 'on' || state.live.status === 'paused';
}

export async function initLive() {
  frame = $('preview-frame');
  addressEl = $('preview-address');
  emptyEl = $('preview-empty');
  openLink = $('preview-open');
  liveButton = $('btn-live');
  liveLabel = liveButton.querySelector('.btn-live-label');

  liveButton.addEventListener('click', () => toggle());
  $('btn-live-stop').addEventListener('click', () => stop());
  $('preview-back').addEventListener('click', () => withFrame((w) => w.history.back()));
  $('preview-forward').addEventListener('click', () => withFrame((w) => w.history.forward()));
  $('preview-reload').addEventListener('click', () => withFrame((w) => w.location.reload()));
  frame.addEventListener('load', updateAddress);
  openLink.removeAttribute('href');

  on('content', onContentChanged);
  on('editor-ready', ({ monaco }) => {
    monaco.editor.onDidChangeMarkers(onMarkersChanged);
  });
  on('tree', () => {
    if (isLive() && state.mode === 'folder') syncTree().catch(reportSyncError);
  });
  on('folder', () => {
    if (isLive() || state.live.status === 'starting') stop({ silent: true });
  });
  on('scratch', (lang) => {
    if (isLive() && state.mode === 'scratch' && lang.id !== 'html') {
      stop({ silent: true });
      toast('Live server stopped: only the HTML language can be previewed.', 'info');
    }
  });
  window.addEventListener('pagehide', () => {
    if ('caches' in window) caches.delete(CACHE_NAME);
  });

  // Never serve files from a previous session.
  if ('caches' in window) await caches.delete(CACHE_NAME).catch(() => {});
}

export function toggle() {
  return isLive() ? stop() : start();
}

function reasonCannotGoLive() {
  if (!state.editorReady) return 'The editor is still loading. Try again in a moment.';
  if (state.mode === 'scratch') {
    const scratch = state.openFiles.find((f) => f.scratch);
    if (!scratch || scratch.language.id !== 'html') {
      return 'Choose the HTML language for the scratch file, or open a folder that contains an index.html, to use the live server.';
    }
    return null;
  }
  if (!state.tree) return 'Open a folder first.';
  return null;
}

/**
 * The preview runs the website's own scripts on this site's origin, so they get the same
 * access as the editor (including the open folder). Say so once, before the first Go Live.
 */
async function confirmConsent() {
  try {
    if (localStorage.getItem(CONSENT_KEY) === 'yes') return true;
  } catch {
    /* localStorage unavailable: ask every time */
  }
  const accepted = await confirmDialog({
    title: 'Start the live server?',
    message: 'The preview runs your website\'s own scripts with the same access as this editor, '
      + 'including the folder you opened. Only preview code you trust. You will not be asked again on this browser.',
    confirmLabel: 'Go Live',
    cancelLabel: 'Cancel',
  });
  if (accepted) {
    try {
      localStorage.setItem(CONSENT_KEY, 'yes');
    } catch {
      /* fine: we will ask again next time */
    }
  }
  return accepted;
}

export async function start() {
  if (isLive() || state.live.status === 'starting') return;
  const reason = reasonCannotGoLive();
  if (reason) {
    toast(reason, 'warning', 6000);
    return;
  }
  if (!(await confirmConsent())) return;
  if (isLive() || state.live.status === 'starting') return; // started elsewhere while the dialog was open
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    toast('Live Server needs a browser with Service Worker support, served over https:// or http://localhost.', 'error');
    return;
  }

  setStatus('starting');
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    liveBase = new URL('live/', registration.scope).href;
    channel = channel || new BroadcastChannel(CHANNEL_NAME);
    await fullSync();
  } catch (err) {
    console.error(err);
    setStatus('off');
    toast(`Unable to start the live server: ${err.message}. It works on https:// or http://localhost, not from a file:// address.`, 'error');
    return;
  }

  setStatus('on');
  showPreview(entryPage());
  if (pending.size) scheduleSync(0);
  toast('Live server started. The preview refreshes as you type, as long as the code has no errors.', 'success', 4000);
}

export async function stop({ silent = false } = {}) {
  clearTimeout(syncTimer);
  syncTimer = null;
  pending.clear();
  synced.clear();
  if (!isLive() && state.live.status !== 'starting') return;

  setStatus('off');
  hidePreview();
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    /* nothing to clear */
  }
  channel?.postMessage({ type: 'reload' }); // preview tabs now show the 404 page, and reload when live again
  if (!silent) toast('Live server stopped.', 'info', 2500);
}

/* ---------- Which page to show ---------- */

function isHtml(path) {
  return /\.html?$/i.test(path);
}

function firstHtml(node) {
  if (!node) return null;
  if (node.kind === 'file') return isHtml(node.path) ? node.path : null;
  for (const child of node.children) {
    const hit = firstHtml(child);
    if (hit) return hit;
  }
  return null;
}

function entryPage() {
  if (state.mode === 'scratch') return 'index.html';
  const active = state.openFiles.find((f) => f.path === state.activePath);
  if (active && isHtml(active.path)) return active.path;
  if (fs.findNode(state.tree, 'index.html')) return 'index.html';
  return firstHtml(state.tree) || 'index.html';
}

/* ---------- Keeping the cache in step with the files ---------- */

function liveUrl(path) {
  return new URL(path.split('/').map(encodeURIComponent).join('/'), liveBase).href;
}

function collectFiles(node, out = []) {
  if (!node) return out;
  if (node.kind === 'file') out.push(node.path);
  else for (const child of node.children) collectFiles(child, out);
  return out;
}

async function putFile(cache, path, body) {
  const response = new Response(body, {
    headers: { 'Content-Type': mimeFor(path), 'Cache-Control': 'no-store' },
  });
  await cache.put(liveUrl(path), response);
  synced.add(path);
}

/** Copy one file into the cache: from the editor if it is open, otherwise from the folder. */
async function syncPath(cache, path) {
  if (state.mode === 'scratch') {
    const scratch = state.openFiles.find((f) => f.scratch);
    if (scratch) await putFile(cache, 'index.html', scratch.model.getValue());
    return;
  }
  const open = state.openFiles.find((f) => f.path === path && f.model);
  if (open) {
    await putFile(cache, path, open.model.getValue());
    return;
  }
  const body = fs.isBinaryPath(path) ? await fs.readBinary(path) : await fs.readText(path);
  await putFile(cache, path, body);
}

async function fullSync() {
  await caches.delete(CACHE_NAME);
  synced.clear();
  pending.clear();
  const cache = await caches.open(CACHE_NAME);

  if (state.mode === 'scratch') {
    await syncPath(cache, 'index.html');
    return;
  }

  let failed = 0;
  for (const path of collectFiles(state.tree)) {
    try {
      await syncPath(cache, path);
    } catch (err) {
      failed += 1;
      console.warn(`Live server: unable to read ${path}`, err);
    }
  }
  if (failed) {
    toast(`${failed} file${failed === 1 ? '' : 's'} could not be read and will be missing from the preview.`, 'warning', 6000);
  }
}

/** The explorer changed (a file was created or deleted): add new files, drop removed ones. */
async function syncTree() {
  const cache = await caches.open(CACHE_NAME);
  const current = new Set(collectFiles(state.tree));
  let changed = false;
  for (const path of current) {
    if (!synced.has(path)) {
      await syncPath(cache, path);
      changed = true;
    }
  }
  for (const path of [...synced]) {
    if (!current.has(path)) {
      await cache.delete(liveUrl(path), { ignoreSearch: true });
      synced.delete(path);
      changed = true;
    }
  }
  if (changed) channel.postMessage({ type: 'reload' });
}

function onContentChanged(entry) {
  if (!isLive() && state.live.status !== 'starting') return;
  pending.add(entry.scratch ? 'index.html' : entry.path);
  scheduleSync(CONFIG.liveRefreshDelay);
}

/**
 * Monaco finished (re)checking a file. Errors fixed while we were paused → sync now.
 * Errors that appeared later than our check → show "paused" so the next edit is not a surprise.
 */
function onMarkersChanged() {
  if (!isLive()) return;
  if (pending.size) {
    if (state.live.status === 'paused') scheduleSync(0);
    return;
  }
  const errors = errorCount();
  if (errors > 0) setStatus('paused', errors);
  else if (state.live.status === 'paused') setStatus('on');
}

/**
 * Count errors for the files about to be pushed. Monaco checks files in the background a
 * moment after you type, so its markers can lag behind; for JavaScript/TypeScript we ask the
 * language worker directly and for JSON we parse it ourselves. Everything else (CSS) uses the
 * markers. Returns the count plus a snapshot of the exact text that was checked.
 */
async function checkPending(paths) {
  const monaco = getMonaco();
  const snapshots = new Map();
  const checkedDirectly = new Set();
  let errors = 0;

  for (const path of paths) {
    const entry = state.openFiles.find((f) => (f.scratch ? 'index.html' : f.path) === path && f.model);
    if (!entry || entry.model.isDisposed()) continue;
    const text = entry.model.getValue();
    snapshots.set(path, text);

    const language = entry.model.getLanguageId();
    if (language === 'javascript' || language === 'typescript') {
      const getWorker = language === 'javascript'
        ? monaco.languages.typescript.getJavaScriptWorker
        : monaco.languages.typescript.getTypeScriptWorker;
      const client = await (await getWorker())(entry.model.uri);
      if (entry.model.isDisposed()) continue;
      const diagnostics = await client.getSyntacticDiagnostics(entry.model.uri.toString());
      errors += diagnostics.length;
      checkedDirectly.add(entry);
    } else if (language === 'json') {
      try {
        JSON.parse(text);
      } catch {
        errors += 1;
      }
      checkedDirectly.add(entry);
    }
  }

  errors += collectProblems().filter((p) => p.isError && !checkedDirectly.has(p.file)).length;
  return { errors, snapshots };
}

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    trySync().catch(reportSyncError);
  }, delay);
}

/** Push pending changes to the preview, unless the code currently has errors. */
async function trySync() {
  if (!isLive() || !pending.size) return;

  const paths = [...pending];
  const { errors, snapshots } = await checkPending(paths);
  if (!isLive()) return; // stopped while we were checking
  if (errors > 0) {
    setStatus('paused', errors); // `pending` is kept; a marker change re-runs this
    return;
  }

  for (const path of paths) pending.delete(path); // edits made during the check stay pending
  const cache = await caches.open(CACHE_NAME);
  for (const path of paths) {
    if (snapshots.has(path)) await putFile(cache, path, snapshots.get(path)); // exactly the text we checked
    else await syncPath(cache, path);
  }
  setStatus('on');

  const cssOnly = paths.every((p) => /\.css$/i.test(p));
  if (cssOnly) {
    for (const p of paths) channel.postMessage({ type: 'css', path: new URL(liveUrl(p)).pathname });
  } else {
    channel.postMessage({ type: 'reload' });
  }
}

function reportSyncError(err) {
  console.error(err);
  toast(`The live server could not update the preview: ${err.message}`, 'error');
}

/* ---------- Status and preview panel ---------- */

function setStatus(status, errors = 0) {
  state.live = { status, errors };
  emit('live', state.live);
  const running = status === 'on' || status === 'paused';
  liveButton.setAttribute('aria-pressed', String(running));
  liveLabel.textContent = running ? 'Stop Live' : status === 'starting' ? 'Starting…' : 'Go Live';
  liveButton.title = running ? 'Stop the live server' : 'Start the live server and preview your website';
}

function showPreview(path) {
  const url = liveUrl(path);
  frame.hidden = false;
  emptyEl.hidden = true;
  frame.src = url;
  openLink.href = url;
  addressEl.textContent = displayPath(url);
  togglePreview(true);
}

function hidePreview() {
  frame.src = 'about:blank';
  frame.hidden = true;
  emptyEl.hidden = false;
  openLink.removeAttribute('href');
  addressEl.textContent = 'live/';
  togglePreview(false);
}

function updateAddress() {
  try {
    const href = frame.contentWindow.location.href;
    if (href && href !== 'about:blank') {
      addressEl.textContent = displayPath(href);
      openLink.href = href;
    }
  } catch {
    /* a page from another origin: leave the address as it is */
  }
}

function displayPath(href) {
  const url = new URL(href);
  const basePath = new URL(liveBase).pathname;
  if (url.pathname.startsWith(basePath)) return 'live/' + decodeURIComponent(url.pathname.slice(basePath.length));
  return url.pathname;
}

function withFrame(fn) {
  try {
    fn(frame.contentWindow);
  } catch (err) {
    console.warn(err);
  }
}

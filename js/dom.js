// js/dom.js — tiny helpers for building HTML safely and other small utilities.

/** Escape text so it can be placed inside innerHTML without being read as HTML. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Create an element with a class name and optional inner HTML. */
export function el(tag, className = '', html = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

/** Shorthand for document.getElementById. */
export const $ = (id) => document.getElementById(id);

/** Keep a number between two limits. */
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Hand a file to the browser's downloader (used when we cannot write to the disk ourselves). */
export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download a text file to the user's computer. */
export function downloadText(name, text) {
  downloadBlob(name, new Blob([text], { type: 'text/plain;charset=utf-8' }));
}

/**
 * Run `task` over every item with at most `limit` running at once. Reading files is one round
 * trip to the disk each, so doing them strictly one after another makes a big folder crawl —
 * and doing all of them at once floods the browser. Used by the live server and by Search.
 */
export async function mapLimit(items, limit, task) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** "84 KB", "1.2 MB" — a size a person can read, for image and binary files. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

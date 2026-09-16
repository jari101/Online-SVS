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

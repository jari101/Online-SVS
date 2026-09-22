// js/imageview.js — the tab you get when you click a .png, .jpg, .gif, .webp or .ico.
//
// The picture sits on a grey checkerboard, so the see-through parts of a PNG read as
// see-through instead of blending into the dark background. It is scaled down to fit the
// tab; clicking it (or the button) shows it at its real size, with scrollbars if it is big.
// Underneath: how many pixels across, how large the file is, and what kind of image it is.
//
// The bytes never leave the browser — they are turned into a blob: URL, which is a name for
// data this tab already holds. editor.js revokes it when the tab is closed.

import * as fs from './fs/index.js';
import { escapeHtml, formatBytes } from './dom.js';
import { icons } from './icons.js';

// Switching tabs quickly must not let a slow read paint over the tab you ended up on.
let renderToken = 0;
// Watches the tab for a change of size, so the "shown at 42%" note stays true.
let watcher = null;

function stopWatching() {
  watcher?.disconnect();
  watcher = null;
}

/** Let go of the picture currently shown in `host` (not of the tab's blob: URL). */
export function releaseImage(host) {
  renderToken += 1;
  stopWatching();
  // Taking the attribute away (rather than emptying it) stops a download in progress
  // without the browser reporting it as a failed image.
  host?.querySelector('.image-canvas')?.removeAttribute('src');
}

/** Show `entry` (a binary tab for an image file) inside `host`, the editor's placeholder area. */
export async function showImage(host, entry) {
  const token = ++renderToken;
  stopWatching();
  host.innerHTML = `
    <div class="placeholder-content">
      <div class="placeholder-logo">${icons.image}</div>
      <p>Loading ${escapeHtml(entry.name)}…</p>
    </div>`;

  if (!entry.objectUrl) {
    const bytes = await fs.readBinary(entry.path);
    if (token !== renderToken) return; // another tab won the race
    entry.objectUrl = URL.createObjectURL(new Blob([bytes], { type: fs.mimeFor(entry.path) }));
    if (entry.size === undefined) entry.size = bytes.byteLength;
  }

  const kind = fs.extOf(entry.path).toUpperCase();
  host.innerHTML = `
    <figure class="image-view${entry.imageFit === false ? '' : ' fit'}">
      <div class="image-stage">
        <button type="button" class="image-button" title="Click to switch between fitting the tab and full size">
          <img class="image-canvas" alt="${escapeHtml(entry.name)}">
        </button>
      </div>
      <figcaption class="image-bar">
        <span class="image-name">${escapeHtml(entry.name)}</span>
        <span class="image-meta">${escapeHtml(formatBytes(entry.size ?? 0))} · ${escapeHtml(kind)}</span>
        <button type="button" class="btn btn-secondary btn-small image-zoom"></button>
      </figcaption>
    </figure>`;

  const view = host.querySelector('.image-view');
  const img = host.querySelector('.image-canvas');
  const meta = host.querySelector('.image-meta');
  const zoom = host.querySelector('.image-zoom');

  /**
   * "800 × 600 · 84 KB · PNG · shown at 42%" — the percentage is only there when the picture
   * is not at its own size, which is what explains a big image looking small in a small tab.
   */
  const syncMeta = () => {
    if (!img.naturalWidth) return;
    const shown = Math.round((img.getBoundingClientRect().width / img.naturalWidth) * 100);
    const scale = shown && shown !== 100 ? ` · shown at ${shown}%` : '';
    meta.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${formatBytes(entry.size ?? 0)} · ${kind}${scale}`;
  };
  const syncZoomButton = () => {
    const fitted = view.classList.contains('fit');
    zoom.textContent = fitted ? 'Full size' : 'Fit to tab';
    zoom.setAttribute('aria-label', fitted ? 'Show the image at full size' : 'Scale the image to fit the tab');
  };
  const toggle = () => {
    view.classList.toggle('fit');
    entry.imageFit = view.classList.contains('fit');
    syncZoomButton();
    syncMeta();
  };
  syncZoomButton();
  zoom.addEventListener('click', toggle);
  host.querySelector('.image-button').addEventListener('click', toggle);

  img.addEventListener('load', () => {
    if (token !== renderToken) return; // this tab is no longer the one on screen
    syncMeta();
    // Dragging the divider changes how much the picture has to shrink by.
    if (typeof ResizeObserver === 'function') {
      watcher = new ResizeObserver(syncMeta);
      watcher.observe(host.querySelector('.image-stage'));
    }
  });
  img.addEventListener('error', () => {
    if (token !== renderToken) return; // ditto: never paint over whatever took our place
    host.innerHTML = `
      <div class="placeholder-content">
        <div class="placeholder-logo">${icons.file}</div>
        <h2>${escapeHtml(entry.name)}</h2>
        <p>This image could not be displayed — the file may be damaged or not really a ${escapeHtml(kind)}.</p>
      </div>`;
  });
  img.src = entry.objectUrl;
}

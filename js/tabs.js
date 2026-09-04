// js/tabs.js — draws the row of editor tabs from state.openFiles.

import { state, on } from './state.js';
import { icons, fileTypeClass } from './icons.js';
import { activateFile, closeFile } from './editor.js';
import { escapeHtml, el } from './dom.js';

let host = null;

export function initTabs(container) {
  host = container;
  on('tabs', render);
  on('active', render);
  render();
}

function render() {
  if (!host) return;
  host.innerHTML = '';
  for (const file of state.openFiles) {
    const tab = el('div', 'tab');
    tab.setAttribute('role', 'tab');
    tab.dataset.path = file.path;
    if (file.path === state.activePath) tab.classList.add('active');
    if (file.dirty) tab.classList.add('dirty');
    if (file.scratch) tab.classList.add('scratch');
    tab.title = file.scratch ? 'Scratch file — kept in this browser, download it with Ctrl+S' : file.path;
    tab.innerHTML = `
      <span class="tree-icon ${fileTypeClass(file.name)}">${icons.file}</span>
      <span class="tab-name">${escapeHtml(file.name)}</span>
      <button class="tab-close" title="Close" tabindex="-1">
        <span class="icon-close">${icons.close}</span>
        <span class="icon-dot">${icons.dot}</span>
      </button>`;

    tab.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) closeFile(file.path);
      else activateFile(file.path);
    });
    // Middle mouse button closes a tab, like in VS Code and browsers.
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeFile(file.path);
      }
    });
    host.appendChild(tab);
  }
  host.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

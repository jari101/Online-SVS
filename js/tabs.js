// js/tabs.js — draws the row of editor tabs from state.openFiles.
// Keyboard: Tab focuses the active tab, Left/Right move between tabs, Delete closes one.

import { state, on } from './state.js';
import { icons, fileTypeClass } from './icons.js';
import { activateFile, closeFile } from './editor.js';
import { escapeHtml, el } from './dom.js';

let host = null;

export function initTabs(container) {
  host = container;
  host.addEventListener('keydown', onKeydown);
  on('tabs', render);
  on('active', render);
  render();
}

function render() {
  if (!host) return;
  const hadFocus = host.contains(document.activeElement);
  host.innerHTML = '';

  for (const file of state.openFiles) {
    const isActive = file.path === state.activePath;
    const tab = el('div', 'tab');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(isActive));
    tab.tabIndex = isActive ? 0 : -1; // roving tabindex: only the active tab is in the Tab order
    tab.dataset.path = file.path;
    if (isActive) tab.classList.add('active');
    if (file.dirty) tab.classList.add('dirty');
    if (file.scratch) tab.classList.add('scratch');
    tab.title = file.scratch ? 'Scratch file — kept in this browser, download it with Ctrl+S' : file.path;

    const closeLabel = file.dirty ? `Close ${file.name} (unsaved changes)` : `Close ${file.name}`;
    tab.innerHTML = `
      <span class="tree-icon ${fileTypeClass(file.name)}">${icons.file}</span>
      <span class="tab-name">${escapeHtml(file.name)}${file.dirty ? '<span class="sr-only"> (unsaved)</span>' : ''}</span>
      <button class="tab-close" aria-label="${escapeHtml(closeLabel)}" tabindex="-1">
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

  const active = host.querySelector('.tab.active');
  active?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  if (hadFocus) (active || host.querySelector('.tab'))?.focus();
}

function onKeydown(e) {
  const tabs = [...host.querySelectorAll('.tab')];
  const current = e.target.closest('.tab');
  if (!current || !tabs.length) return;
  const index = tabs.indexOf(current);
  const go = (i) => {
    const target = tabs[(i + tabs.length) % tabs.length];
    activateFile(target.dataset.path);
    // activateFile() hands focus to the editor; keyboard users expect to stay on the tab bar.
    host.querySelector('.tab.active')?.focus();
  };
  switch (e.key) {
    case 'ArrowRight': e.preventDefault(); go(index + 1); break;
    case 'ArrowLeft': e.preventDefault(); go(index - 1); break;
    case 'Home': e.preventDefault(); go(0); break;
    case 'End': e.preventDefault(); go(tabs.length - 1); break;
    case 'Enter': case ' ': e.preventDefault(); activateFile(current.dataset.path); break;
    case 'Delete': e.preventDefault(); closeFile(current.dataset.path); break;
    default: break;
  }
}

// js/layout.js — draggable dividers, showing/hiding the sidebar, panel and preview,
// and switching which view the sidebar shows (Explorer or Settings).

import { state, emit } from './state.js';

const app = () => document.getElementById('app');
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function initLayout() {
  makeDivider('divider-sidebar', {
    axis: 'x',
    cssVar: '--sidebar-w',
    direction: 1,
    min: 160,
    max: () => window.innerWidth * 0.5,
    measure: () => document.getElementById('sidebar').getBoundingClientRect().width,
  });
  makeDivider('divider-preview', {
    axis: 'x',
    cssVar: '--preview-w',
    direction: -1,
    min: 220,
    max: () => window.innerWidth * 0.7,
    measure: () => document.getElementById('preview').getBoundingClientRect().width,
  });
  makeDivider('divider-panel', {
    axis: 'y',
    cssVar: '--panel-h',
    direction: -1,
    min: 80,
    max: () => window.innerHeight * 0.75,
    measure: () => document.getElementById('panel').getBoundingClientRect().height,
  });

  for (const button of document.querySelectorAll('#activitybar .activity[data-view]')) {
    button.addEventListener('click', () => activityClick(button.dataset.view));
  }
  syncButtons();
}

/**
 * Turn an element into a drag handle that changes one CSS variable.
 * Pointer capture keeps the drag working even when the mouse moves over an iframe.
 */
function makeDivider(id, opts) {
  const divider = document.getElementById(id);
  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    document.body.style.cursor = opts.axis === 'x' ? 'col-resize' : 'row-resize';
    const start = opts.axis === 'x' ? e.clientX : e.clientY;
    const startSize = opts.measure();

    const move = (ev) => {
      const now = opts.axis === 'x' ? ev.clientX : ev.clientY;
      const size = clamp(startSize + (now - start) * opts.direction, opts.min, opts.max());
      app().style.setProperty(opts.cssVar, `${size}px`);
    };
    const stop = () => {
      divider.classList.remove('dragging');
      document.body.style.cursor = '';
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', stop);
      divider.removeEventListener('pointercancel', stop);
      emit('layout');
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);
  });
  // Double-click puts the pane back to its default size.
  divider.addEventListener('dblclick', () => {
    app().style.removeProperty(opts.cssVar);
    emit('layout');
  });
}

function setHidden(className, hidden) {
  app().classList.toggle(className, hidden);
  syncButtons();
  emit('layout');
}

/** `show` = true forces visible, false forces hidden, undefined toggles. */
export function toggleSidebar(show) {
  const hidden = show === undefined ? !app().classList.contains('hide-sidebar') : !show;
  setHidden('hide-sidebar', hidden);
}

export function togglePanel(show) {
  const hidden = show === undefined ? !app().classList.contains('hide-panel') : !show;
  setHidden('hide-panel', hidden);
}

export function togglePreview(show) {
  const hidden = show === undefined ? !app().classList.contains('hide-preview') : !show;
  setHidden('hide-preview', hidden);
}

export function isPanelVisible() {
  return !app().classList.contains('hide-panel');
}

/** Show one of the sidebar views ('explorer' or 'settings') and make sure the sidebar is open. */
export function showSidebarView(view) {
  state.sidebarView = view;
  for (const section of document.querySelectorAll('.sidebar-view')) {
    section.hidden = section.id !== `view-${view}`;
  }
  toggleSidebar(true);
  emit('sidebar-view', view);
}

/** Clicking the icon of the view that is already open hides the sidebar, like VS Code. */
function activityClick(view) {
  const sidebarHidden = app().classList.contains('hide-sidebar');
  if (state.sidebarView === view && !sidebarHidden) toggleSidebar(false);
  else showSidebarView(view);
}

function syncButtons() {
  const a = app();
  for (const button of document.querySelectorAll('#activitybar .activity[data-view]')) {
    const active = button.dataset.view === state.sidebarView && !a.classList.contains('hide-sidebar');
    button.classList.toggle('active', active);
  }
  document.getElementById('btn-toggle-panel')?.classList.toggle('active', !a.classList.contains('hide-panel'));
  document.getElementById('btn-toggle-preview')?.classList.toggle('active', !a.classList.contains('hide-preview'));
}

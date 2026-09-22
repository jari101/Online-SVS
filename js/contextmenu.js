// js/contextmenu.js — the little menu that appears on a right-click.
//
// One menu element is reused for every one that opens. It is a real menu for the keyboard
// too: Arrow keys move, Enter chooses, Escape closes and puts the focus back where it was,
// so the Explorer can offer Rename and Delete without a mouse (Shift+F10 or the Menu key).

import { el, clamp } from './dom.js';

let menu = null;
let closeCurrent = null;

function ensureMenu() {
  if (menu) return menu;
  menu = el('div', 'context-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.appendChild(menu);
  return menu;
}

/** Close the open menu, if there is one. */
export function closeContextMenu() {
  if (closeCurrent) closeCurrent();
}

/**
 * Show a menu at a point on the screen.
 * @param {number} options.x, options.y  where the pointer was (or the corner of a row)
 * @param {Array} options.items  { label, onClick, danger?, disabled?, hint? } or { separator: true }
 * @param {Element} [options.returnFocusTo]  focused again when the menu closes
 */
export function openContextMenu({ x, y, items, returnFocusTo = null }) {
  closeContextMenu();
  const box = ensureMenu();
  box.innerHTML = '';

  for (const item of items) {
    if (item.separator) {
      const line = el('div', 'context-separator');
      line.setAttribute('role', 'separator');
      box.appendChild(line);
      continue;
    }
    const button = el('button', `context-item${item.danger ? ' danger' : ''}`);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.disabled = Boolean(item.disabled);
    button.innerHTML = '<span class="context-label"></span><span class="context-hint"></span>';
    button.querySelector('.context-label').textContent = item.label;
    button.querySelector('.context-hint').textContent = item.hint || '';
    button.addEventListener('click', () => {
      close();
      item.onClick();
    });
    box.appendChild(button);
  }

  // Measure it before placing it, so a menu near the edge of the window flips instead of
  // hanging off the screen.
  box.hidden = false;
  box.style.visibility = 'hidden';
  box.style.left = '0px';
  box.style.top = '0px';
  const { width, height } = box.getBoundingClientRect();
  box.style.left = `${clamp(x, 4, Math.max(4, window.innerWidth - width - 4))}px`;
  box.style.top = `${clamp(y, 4, Math.max(4, window.innerHeight - height - 4))}px`;
  box.style.visibility = '';

  const itemsOf = () => [...box.querySelectorAll('.context-item:not(:disabled)')];
  itemsOf()[0]?.focus();

  function move(step) {
    const all = itemsOf();
    if (!all.length) return;
    const index = all.indexOf(document.activeElement);
    all[(index + step + all.length) % all.length].focus();
  }

  function onKeydown(e) {
    switch (e.key) {
      case 'Escape': e.preventDefault(); close(); break;
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'Home': e.preventDefault(); itemsOf()[0]?.focus(); break;
      case 'End': e.preventDefault(); itemsOf().at(-1)?.focus(); break;
      case 'Tab': e.preventDefault(); close(); break;
      default: break;
    }
  }

  function onPointerDown(e) {
    if (!box.contains(e.target)) close();
  }

  function close() {
    if (closeCurrent !== close) return;
    closeCurrent = null;
    box.hidden = true;
    box.innerHTML = '';
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    // Scrolling the tree would leave the menu pointing at the wrong row.
    document.removeEventListener('scroll', close, true);
    returnFocusTo?.focus?.();
  }

  closeCurrent = close;
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', close, true);
  return close;
}

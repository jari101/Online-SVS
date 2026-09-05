// js/toast.js — small notifications in the bottom-right corner ("Saved index.html").
// Errors stay until you dismiss them; everything else fades after a few seconds.

import { icons } from './icons.js';
import { el } from './dom.js';

export function toast(message, type = 'info', duration = 3000) {
  const host = document.getElementById('toasts');
  if (!host) return () => {};

  const item = el('div', `toast ${type}`);
  item.innerHTML = `<span class="toast-text"></span><button class="toast-close" aria-label="Dismiss notification">${icons.close}</button>`;
  item.querySelector('.toast-text').textContent = message;

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    item.classList.add('leaving');
    setTimeout(() => item.remove(), 200);
  };
  item.querySelector('.toast-close').addEventListener('click', remove);
  host.appendChild(item);

  const sticky = type === 'error' || duration === 0;
  if (!sticky) setTimeout(remove, duration);
  return remove;
}

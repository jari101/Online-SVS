// js/toast.js — small notifications in the bottom-right corner ("Saved index.html").
// Errors stay until you dismiss them; everything else fades after a few seconds.
// A toast can also carry buttons ("Keep mine" / "Load theirs"), which is how a file that
// changed on your disk asks what to do without a modal dialog interrupting your typing.

import { icons } from './icons.js';
import { el } from './dom.js';

/**
 * Show a notification. Returns a function that removes it again.
 * @param {string} message      what happened, in plain words
 * @param {'info'|'success'|'warning'|'error'} type
 * @param {number} duration     ms before it fades; 0 keeps it until dismissed
 * @param {{label: string, onClick: Function, primary?: boolean}[]} [options.actions]
 *        buttons shown under the message. A toast with buttons never fades on its own.
 * @param {Function} [options.onDismiss]
 *        called when it goes away without any of its buttons being pressed, so a question
 *        closed with the × does not leave the asker waiting for an answer for ever.
 */
export function toast(message, type = 'info', duration = 3000, { actions = [], onDismiss = null } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return () => {};

  const item = el('div', `toast ${type}`);
  item.innerHTML = `
    <div class="toast-body">
      <span class="toast-text"></span>
      <div class="toast-actions"></div>
    </div>
    <button class="toast-close" aria-label="Dismiss notification">${icons.close}</button>`;
  item.querySelector('.toast-text').textContent = message;

  let removed = false;
  let answered = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    item.classList.add('leaving');
    setTimeout(() => item.remove(), 200);
    if (!answered && onDismiss) onDismiss();
  };

  const actionHost = item.querySelector('.toast-actions');
  for (const action of actions) {
    const button = el('button', `btn btn-small${action.primary ? '' : ' btn-secondary'}`);
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      answered = true;
      remove();
      action.onClick();
    });
    actionHost.appendChild(button);
  }
  if (!actions.length) actionHost.remove();

  item.querySelector('.toast-close').addEventListener('click', remove);
  host.appendChild(item);

  // A question with buttons waits for an answer, and an error is worth reading twice.
  const sticky = type === 'error' || duration === 0 || actions.length > 0;
  if (!sticky) setTimeout(remove, duration);
  return remove;
}

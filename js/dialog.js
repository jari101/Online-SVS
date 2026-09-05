// js/dialog.js — a confirmation box built on the native <dialog> element.
// Unlike window.confirm(), its buttons can say what they do ("Close without saving").
// showModal() gives us focus trapping, Escape-to-cancel and a dimmed background for free.

let dialog = null;

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  dialog.setAttribute('aria-describedby', 'dialog-message');
  dialog.innerHTML = `
    <form method="dialog" class="dialog-form">
      <h2 class="dialog-title" id="dialog-title"></h2>
      <p class="dialog-message" id="dialog-message"></p>
      <div class="dialog-actions">
        <button type="submit" value="cancel" class="btn btn-secondary dialog-cancel"></button>
        <button type="submit" value="confirm" class="btn dialog-confirm"></button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  return dialog;
}

/**
 * Ask a yes/no question. Resolves to true when the confirm button is pressed,
 * false on cancel or Escape.
 */
export function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  const box = ensureDialog();
  box.querySelector('.dialog-title').textContent = title;
  box.querySelector('.dialog-message').textContent = message;
  const confirmButton = box.querySelector('.dialog-confirm');
  const cancelButton = box.querySelector('.dialog-cancel');
  confirmButton.textContent = confirmLabel;
  confirmButton.classList.toggle('btn-danger', danger);
  cancelButton.textContent = cancelLabel;

  return new Promise((resolve) => {
    const onClose = () => {
      box.removeEventListener('close', onClose);
      resolve(box.returnValue === 'confirm');
    };
    box.addEventListener('close', onClose);
    box.returnValue = '';
    box.showModal();
    cancelButton.focus(); // the safe choice is focused first
  });
}

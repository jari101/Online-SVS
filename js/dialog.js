// js/dialog.js — confirmation and prompt boxes built on the native <dialog> element.
// Unlike window.confirm(), the buttons can say what they do ("Close without saving"), and
// unlike window.prompt(), the text box can refuse a bad name and explain why.
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
      <label class="dialog-field" hidden>
        <span class="dialog-field-label"></span>
        <input class="dialog-input" type="text" spellcheck="false" autocomplete="off">
      </label>
      <p class="dialog-error" role="alert" hidden></p>
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
  box.querySelector('.dialog-field').hidden = true; // the box is shared with promptDialog
  box.querySelector('.dialog-error').hidden = true;

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

/**
 * Ask for a line of text. Resolves to the trimmed text, or null on cancel or Escape.
 * `validate(text)` returns a message to show instead of closing, or null when the text is fine.
 */
export function promptDialog({
  title, message, label = 'Name', value = '', placeholder = '',
  confirmLabel = 'OK', cancelLabel = 'Cancel', validate = null,
}) {
  const box = ensureDialog();
  box.querySelector('.dialog-title').textContent = title;
  box.querySelector('.dialog-message').textContent = message;
  box.querySelector('.dialog-field-label').textContent = label;

  const field = box.querySelector('.dialog-field');
  const input = box.querySelector('.dialog-input');
  const error = box.querySelector('.dialog-error');
  const confirmButton = box.querySelector('.dialog-confirm');
  const cancelButton = box.querySelector('.dialog-cancel');
  field.hidden = false;
  error.hidden = true;
  input.value = value;
  input.placeholder = placeholder;
  confirmButton.textContent = confirmLabel;
  confirmButton.classList.remove('btn-danger');
  cancelButton.textContent = cancelLabel;

  return new Promise((resolve) => {
    // Cancelling the click also cancels the form submission, so a bad name keeps the box open.
    const onConfirm = (e) => {
      const problem = validate ? validate(input.value.trim()) : null;
      if (!problem) return;
      e.preventDefault();
      error.textContent = problem;
      error.hidden = false;
      input.focus();
      input.select();
    };
    // Enter would otherwise pick the first submit button in the form, which is Cancel.
    const onKeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      confirmButton.click();
    };
    const onClose = () => {
      confirmButton.removeEventListener('click', onConfirm);
      input.removeEventListener('keydown', onKeydown);
      box.removeEventListener('close', onClose);
      field.hidden = true;
      error.hidden = true;
      resolve(box.returnValue === 'confirm' ? input.value.trim() : null);
    };
    confirmButton.addEventListener('click', onConfirm);
    input.addEventListener('keydown', onKeydown);
    box.addEventListener('close', onClose);
    box.returnValue = '';
    box.showModal();
    input.focus();
    input.select();
  });
}

// js/toast.js — small notifications in the bottom-right corner ("Saved index.html").

export function toast(message, type = 'info', duration = 3000) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// js/fonts.js — the editor fonts you can pick in Settings and how they get downloaded.
// "default" needs no download: the browser uses whichever of these fonts the computer has.

export const FONTS = [
  {
    id: 'default',
    label: 'Default (Consolas / Menlo)',
    family: 'Consolas, Menlo, Monaco, "Droid Sans Mono", "Courier New", monospace',
    ligatures: false,
  },
  {
    id: 'fira-code',
    label: 'Fira Code',
    family: '"Fira Code", Consolas, Menlo, monospace',
    ligatures: true,
    css: 'https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&display=swap',
  },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    family: '"JetBrains Mono", Consolas, Menlo, monospace',
    ligatures: true,
    css: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'cascadia-code',
    label: 'Cascadia Code',
    family: '"Cascadia Code", Consolas, Menlo, monospace',
    ligatures: true,
    css: 'https://cdn.jsdelivr.net/npm/@fontsource/cascadia-code@5.3.0/index.css',
  },
];

export function fontById(id) {
  return FONTS.find((f) => f.id === id) || FONTS[0];
}

const requested = new Set();

/**
 * Adds the font's stylesheet to the page (once) and waits until the browser has it.
 * If the download fails (offline, blocked), we simply resolve: the family string still
 * lists Consolas/Menlo as fallbacks, so the editor keeps working.
 */
export async function ensureFontLoaded(font) {
  if (!font.css || requested.has(font.id)) return;
  requested.add(font.id);
  await new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = font.css;
    link.onload = resolve;
    link.onerror = () => {
      console.warn(`Could not download font "${font.label}"; using a fallback.`);
      resolve();
    };
    document.head.appendChild(link);
  });
  try {
    const family = font.family.split(',')[0];
    await document.fonts.load(`14px ${family}`);
  } catch {
    /* ignore: the fallback font is used */
  }
}

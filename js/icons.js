// js/icons.js — every icon is an inline SVG string so no icon font or image download is needed.
// They are drawn with `currentColor`, so CSS `color` decides their colour.

const svg = (body, viewBox = '0 0 16 16') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  logo: svg('<rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" stroke="none"/><path d="M5.5 4.5 2.5 8l3 3.5M10.5 4.5 13.5 8l-3 3.5M9 3 7 13" stroke="#fff" stroke-width="1.4"/>'),
  files: svg('<path d="M5 2.5h5.5L14 6v7.5H5z"/><path d="M10.5 2.5V6H14"/><path d="M5 5H2.5v8.5H11V13"/>'),
  search: svg('<circle cx="6.5" cy="6.5" r="4"/><path d="m9.5 9.5 4.5 4.5"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>'),
  chevronRight: svg('<path d="m6 4 4 4-4 4"/>'),
  chevronDown: svg('<path d="m4 6 4 4 4-4"/>'),
  folder: svg('<path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z"/>'),
  folderOpen: svg('<path d="M1.5 3.5h4l1.5 1.5h7.5v2h-11l-2 6z"/><path d="M1.5 13l2-6h12l-2 6z"/>'),
  file: svg('<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/>'),
  newFile: svg('<path d="M4 1.5h5.5L13 5v4"/><path d="M9.5 1.5V5H13"/><path d="M4 1.5v13h4"/><path d="M12 10.5v5M9.5 13h5"/>'),
  newFolder: svg('<path d="M1.5 3.5h4l1.5 1.5h7.5v3"/><path d="M1.5 3.5v9.5h6"/><path d="M12 10.5v5M9.5 13h5"/>'),
  refresh: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/>'),
  collapseAll: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M5.5 8h5"/>'),
  close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  dot: svg('<circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none"/>'),
  play: svg('<path d="M4 2.5v11l9-5.5z" fill="currentColor" stroke="none"/>'),
  bolt: svg('<path d="M9 1.5 3 9h4l-1 5.5L13 7H9z" fill="currentColor" stroke="none"/>'),
  layoutPanel: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 9.5h13"/>'),
  layoutPreview: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M9.5 2.5v11"/>'),
  error: svg('<circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/>'),
  warning: svg('<path d="M8 2 1.8 13h12.4z"/><path d="M8 6.5v3M8 11.5v.2"/>'),
  externalLink: svg('<path d="M9 2.5h4.5V7"/><path d="M13.5 2.5 7 9"/><path d="M11.5 9v4.5h-9v-9H7"/>'),
};

/** Which colour class and icon a file name gets, judged by its extension. */
export function fileTypeClass(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (['html', 'htm'].includes(ext)) return 'ft-html';
  if (['css', 'scss', 'less'].includes(ext)) return 'ft-css';
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'ft-js';
  if (['ts', 'tsx'].includes(ext)) return 'ft-ts';
  if (['json', 'jsonc'].includes(ext)) return 'ft-json';
  if (['md', 'markdown', 'txt'].includes(ext)) return 'ft-md';
  if (['py'].includes(ext)) return 'ft-py';
  if (['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'rs', 'go'].includes(ext)) return 'ft-c';
  if (['java', 'kt', 'php', 'rb', 'swift'].includes(ext)) return 'ft-java';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif'].includes(ext)) return 'ft-image';
  if (ext === 'svg') return 'ft-svg';
  return 'ft-default';
}

/** Fill every element that has a `data-icon="name"` attribute with that SVG. */
export function renderIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const icon = icons[el.dataset.icon];
    if (icon) el.innerHTML = icon;
  }
}

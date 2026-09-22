// js/icons.js — every icon is an inline SVG string so no icon font or image download is needed.
// They are drawn with `currentColor`, so CSS `color` decides their colour.

import { extOf } from './fs/util.js';

const svg = (body, { viewBox = '0 0 16 16', strokeWidth = 1.5 } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" aria-hidden="true" focusable="false">${body}</svg>`;

export const icons = {
  logo: svg('<rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" stroke="none"/><path d="M5.5 4.5 2.5 8l3 3.5M10.5 4.5 13.5 8l-3 3.5M9 3 7 13" stroke="#fff" stroke-width="1.4"/>'),
  files: svg('<path d="M5 2.5h5.5L14 6v7.5H5z"/><path d="M10.5 2.5V6H14"/><path d="M5 5H2.5v8.5H11V13"/>'),
  search: svg('<circle cx="6.5" cy="6.5" r="4"/><path d="m9.5 9.5 4.5 4.5"/>'),
  // Six teeth cut straight out of the rim: fewer, chunkier teeth survive being drawn
  // at 16px in the title bar, where an eight-tooth cog turns into mush.
  gear: svg(
    '<path d="M6.09 3.27L6.4 1.08L9.6 1.08L9.91 3.27A5.1 5.1 0 0 1 11.14 3.98L13.19 3.16L14.79 5.92L13.05 7.29A5.1 5.1 0 0 1 13.05 8.71L14.79 10.08L13.19 12.84L11.14 12.02A5.1 5.1 0 0 1 9.91 12.73L9.6 14.92L6.4 14.92L6.09 12.73A5.1 5.1 0 0 1 4.86 12.02L2.81 12.84L1.21 10.08L2.95 8.71A5.1 5.1 0 0 1 2.95 7.29L1.21 5.92L2.81 3.16L4.86 3.98A5.1 5.1 0 0 1 6.09 3.27Z"/><circle cx="8" cy="8" r="2.3"/>',
    { strokeWidth: 1.3 },
  ),
  chevronRight: svg('<path d="m6 4 4 4-4 4"/>'),
  chevronDown: svg('<path d="m4 6 4 4 4-4"/>'),
  folder: svg('<path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z"/>'),
  folderOpen: svg('<path d="M1.5 3.5h4l1.5 1.5h7.5v2h-11l-2 6z"/><path d="M1.5 13l2-6h12l-2 6z"/>'),
  file: svg('<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/>'),
  // Also drawn in `treeIcons` below, because the preview toolbar shows it at 16px
  // while the Explorer header shows it at 14px, and each size gets its own drawing.
  refresh: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/>'),
  close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  dot: svg('<circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none"/>'),
  play: svg('<path d="M4 2.5v11l9-5.5z" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" stroke="none"/>'),
  bolt: svg('<path d="M9 1.5 3 9h4l-1 5.5L13 7H9z" fill="currentColor" stroke="none"/>'),
  layoutPanel: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 9.5h13"/>'),
  layoutPreview: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M9.5 2.5v11"/>'),
  error: svg('<circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/>'),
  warning: svg('<path d="M8 2 1.8 13h12.4z"/><path d="M8 6.5v3M8 11.5v.2"/>'),
  externalLink: svg('<path d="M9 2.5h4.5V7"/><path d="M13.5 2.5 7 9"/><path d="M11.5 9v4.5h-9v-9H7"/>'),
  arrowLeft: svg('<path d="M13 8H3"/><path d="m7 4-4 4 4 4"/>'),
  arrowRight: svg('<path d="M3 8h10"/><path d="m9 4 4 4-4 4"/>'),
  // A frame with a sun and hills in it: the picture of a picture.
  image: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><circle cx="5.5" cy="6.5" r="1.2"/><path d="m2 11.5 3.5-3 3 2.5 2.5-2.5 3 3"/>'),
  // A box with a lid and a label, the way a zip is drawn everywhere: the lid line keeps it
  // from reading as a plain folder at a glance.
  archive: svg('<rect x="1.5" y="2.5" width="13" height="3"/><path d="M2.5 5.5h11v8h-11z"/><path d="M6.5 8h3"/>'),
};

/* The Explorer header shows these four at 14px, so they are drawn on a 14-unit grid:
   one grid unit is exactly one screen pixel there. Every straight stroke is centred on
   a .5 coordinate, which lands a 1-unit stroke inside a single pixel instead of
   straddling two, and that is what keeps them sharp. Drawing for one size is the whole
   point, so anything rendered at another size should use the 16-unit `icons` above. */
const treeSvg = (body) => svg(body, { viewBox: '0 0 14 14', strokeWidth: 1 });

export const treeIcons = {
  // The old newFile/newFolder put the "+" at the bottom-right corner, where its round
  // cap ran past the viewBox and got sliced flat. Sitting inside the shape, it cannot clip.
  newFile: treeSvg('<path d="M8.5 1.5H2.5v11h9V4.5z"/><path d="M8.5 1.5v3h3"/><path d="M7.5 7.75v3.5M5.75 9.5h3.5"/>'),
  newFolder: treeSvg('<path d="M1.5 3.5h3.5l1.5 2h6v6h-11z"/><path d="M7.5 6.75v3.5M5.75 8.5h3.5"/>'),
  refresh: treeSvg('<path d="M11.5 7a4.5 4.5 0 1 1-1.4-3.2"/><path d="M11.5 2v2.5h-2.75"/>'),
  collapseAll: treeSvg('<rect x="1.5" y="1.5" width="11" height="11" rx="1"/><path d="M4.5 6.5h5"/>'),
};

/** Which colour class a file name gets, judged by its extension. */
export function fileTypeClass(name) {
  const ext = extOf(name);
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
  if (['zip', 'gz', 'tar', 'rar', '7z'].includes(ext)) return 'ft-archive';
  if (ext === 'svg') return 'ft-svg';
  return 'ft-default';
}

/** Fill every element that has a `data-icon="name"` attribute with that SVG. */
export function renderIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    const icon = icons[node.dataset.icon];
    if (icon) node.innerHTML = icon;
  }
}

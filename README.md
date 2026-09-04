# Online SVS

A code editor that runs in your browser, in the spirit of OnlineGDB, with three things
OnlineGDB does not have:

- **Work on a whole folder** from your PC, with a VS Code-style explorer, tabs and editor.
- **Live Server**: preview a website as you type and see it reload, like the VS Code extension. *(Phase 2)*
- **Nothing is stored on the website.** Your files stay on your computer. There are no accounts and no uploads.

Plus the classic OnlineGDB part: pick a language, write a program, press **Run** and read the output. *(Phase 3)*

## Status

| Phase | What | State |
|---|---|---|
| 1 | VS Code Dark+ layout, Monaco editor, tabs, scratch file, open/save folders, explorer, settings | **done** |
| 2 | Live server (Service Worker), preview panel, refresh-on-type when the code has no errors | planned |
| 3 | Run button for C, C++, Python, Java, JavaScript and more via the Piston API, stdin input | planned |
| 4 | Polish: search, rename/delete, quick open, image preview, more settings | planned |

## Try it

Open the site in **Chrome, Edge, Opera or Brave** for the full experience.

1. With no folder open you get a **scratch file**: choose a language in the title bar and start typing.
   The text is remembered in your own browser (localStorage), so a refresh does not lose it.
2. Click **Open Folder** and pick a folder from your computer. The browser asks for permission once.
   Edit files, then press **Ctrl+S** to write them straight back to your disk.
3. No folder handy? Use **Open Folder ▾ → Open Sample Project** for a small website that lives in memory.

Firefox and Safari do not have the File System Access API, so there a folder opens **read-only** and
Ctrl+S downloads the edited file instead.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl + S | Save the current file |
| Ctrl + Shift + S | Save all files |
| Ctrl + B | Show / hide the sidebar |
| Ctrl + J | Show / hide the bottom panel |
| Ctrl + Shift + E | Explorer |
| Ctrl + , | Settings |
| Ctrl + scroll | Zoom the editor |

## Run it locally

There is no build step. Any static web server works (a plain `file://` URL will not: browsers
block modules and Service Workers there).

```bash
# Node
npx http-server -p 8080 -c-1 .
# or Python
python3 -m http.server 8080
```

Then open <http://localhost:8080/>.

## Deploy to GitHub Pages

The workflow in `.github/workflows/pages.yml` publishes the repository root on every push to `main`.

1. Merge this branch into `main`.
2. In the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Wait for the "Deploy to GitHub Pages" action to finish. The site is at
   `https://<your-user>.github.io/Online-SVS/`.

## Project structure

```
index.html            the app shell (title bar, activity bar, sidebar, editor, preview, panel, status bar)
css/theme.css         every colour, font and size (VS Code Dark+ palette)
css/layout.css        the grid, draggable dividers, show/hide states
css/components.css    buttons, tree, tabs, panel, status bar, menus, toasts, settings
js/main.js            starts everything, wires buttons and shortcuts, open/close folder flows
js/config.js          CDN and API addresses, ignored folders, defaults
js/state.js           the shared state object and a tiny event bus (on / emit)
js/editor.js          loads Monaco, opens/saves files, tabs, scratch model
js/tabs.js            draws the editor tabs
js/explorer.js        the file tree, new file / new folder
js/scratch.js         scratch mode + localStorage
js/settings.js        settings view; js/fonts.js lists the fonts you can pick
js/layout.js          dividers, sidebar/panel/preview toggles
js/panel.js           Output / Input / Problems panel
js/statusbar.js       the blue status bar
js/languages.js       languages for the scratch file (with starter programs)
js/fs/index.js        one API for files; native.js = File System Access, memory.js = in-memory fallback + sample
tests/                automated browser test (see below)
```

Monaco (the VS Code editor) is loaded from the jsDelivr CDN, so the first load needs internet.

## Automated test

`tests/smoke.spec.mjs` starts a local server, opens the app in headless Chromium and clicks
through the main features.

```bash
cd tests
npm install                 # playwright, http-server and a local copy of Monaco
npx playwright install chromium   # once, downloads the browser
npm test
```

## Privacy

- Files are read from and written to **your** disk through the browser's File System Access API.
- The scratch file and your settings are kept in **your browser's** localStorage.
- Nothing is uploaded, and there is no server-side storage of any kind.

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
| 2 | Live server (Service Worker), preview panel, refresh-on-type when the code has no errors | **done** |
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

### Live Server

1. Open a folder (or the sample project) and press **Go Live**. The preview panel opens on the right
   and shows your site; **Open in new tab** gives you a normal URL under `…/live/` that you can open
   in another window or a second browser tab.
2. Type. About 0.75 s after you stop, the changed files are pushed to the preview and it reloads.
   A CSS-only change swaps the stylesheet in place, without a flicker.
3. Make a mistake in a script or stylesheet and the status bar switches to
   **Live: paused · 1 error**. Nothing refreshes until the error is gone; click the status item to
   see the Problems list.
4. Press **Stop Live** (or close the folder) to stop. All served files are wiped.

The scratch file can be previewed too: pick the **HTML** language and press Go Live.

How it works: a Service Worker (`sw.js`) answers every request under `live/` from the browser's
Cache API, where `js/live.js` copies the files of your folder. That is why relative links, images,
several pages and `fetch('data.json')` all behave as on a real server. It needs `https://` or
`http://localhost`; a `file://` address cannot run Service Workers.

Two things to know:

- Monaco reports syntax errors for JavaScript, TypeScript, CSS and JSON, but not for HTML, so a
  broken HTML tag still refreshes the preview.
- The preview runs on the same origin as the editor, so a script in the previewed page has the
  same access as the editor itself, including the folder you opened. That is why Go Live asks for
  confirmation the first time. Only preview code you trust; a "free template" downloaded from the
  internet counts as untrusted. The "Open in new tab" window is opened without a reference back to
  the editor, so a page there cannot reach it. Nothing is sent to any server either way.

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
| Arrow keys | Move through the Explorer tree (Right expands, Left collapses), switch editor tabs, resize a focused divider |
| Enter | Open the focused file |
| Delete | Close the focused tab |

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
sw.js                 the Service Worker that serves the live preview from the browser cache
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
js/live.js            live server: syncs files into the cache, error gating, reload messages, preview panel
js/dialog.js          confirmation dialog (native <dialog>) with verb-first buttons
js/toast.js           notifications; errors stay until dismissed
js/statusbar.js       the blue status bar
js/languages.js       languages for the scratch file (with starter programs)
js/fs/index.js        one API for files; native.js = File System Access, memory.js = in-memory fallback + sample
tests/                automated browser test (see below)
```

Monaco (the VS Code editor) is loaded from the jsDelivr CDN, so the first load needs internet.

## Automated test

`tests/smoke.spec.mjs` starts a local server, opens the app in headless Chromium and clicks
through the main features: scratch mode, folders, keyboard navigation, the confirmation dialog,
and the live server (preview, CSS hot swap, pausing on errors, the new-tab URL, 404 page, stop).

```bash
cd tests
npm install                 # playwright, http-server and a local copy of Monaco
npx playwright install chromium   # once, downloads the browser
npm test
```

## Privacy

- Files are read from and written to **your** disk through the browser's File System Access API.
- The scratch file and your settings are kept in **your browser's** localStorage.
- While the live server runs, copies of your files sit in **your browser's** cache so the preview can load them. They are removed when you stop the server, close the folder or reload the app.
- Nothing is uploaded, and there is no server-side storage of any kind.

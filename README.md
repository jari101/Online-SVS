# Online SVS

A code editor that runs in your browser, in the spirit of OnlineGDB, with four things
OnlineGDB does not have:

- **Work on a whole folder** from your PC — or **straight out of a `.zip`** — with a VS Code-style
  explorer, tabs and editor.
- **Live Server**: preview a website as you type and see it reload, like the VS Code extension. *(Phase 2)*
- **Everything goes back where it came from.** Files save into the folder you opened them from,
  that folder is offered again on your next visit, and even the scratch file can be given a
  home on your disk. *(Phase 5)*
- **Nothing is stored on the website.** Your files stay on your computer. There are no accounts and no uploads.

Plus the classic OnlineGDB part: pick a language, write a program, press **Run** and read the output. *(Phase 3)*

## Status

| Phase | What | State |
|---|---|---|
| 1 | VS Code Dark+ layout, Monaco editor, tabs, scratch file, open/save folders, explorer, settings | **done** |
| 2 | Live server (Service Worker), preview panel, refresh-on-type when the code has no errors | **done** |
| 3 | Run button for C, C++, Python, Java, JavaScript and more via the Piston API, stdin input | **done** |
| 4 | Polish: search, rename/delete, quick open, image preview, more settings | planned |
| 5 | Saving back where it came from: reopen your last folder and its tabs, a home on disk for the scratch file, open a folder from a `.zip` and save it back into that same zip | **done** |

## Try it

Open the site in **Chrome, Edge, Opera or Brave** for the full experience.

1. With no folder open you get a **scratch file**: choose a language in the title bar and start typing.
   The text is remembered in your own browser (localStorage), so a refresh does not lose it.
2. Click **Open Folder** and pick a folder from your computer. The browser asks for permission once.
   Edit files, then press **Ctrl+S** to write them straight back to your disk.
3. Got a `.zip` instead of a folder? **Drop it anywhere on the page** — or use **Open Folder ▾ →
   Open Zip File…** — and its files open just like a folder. **Save Folder** packs them back into
   the same zip when you are done.
4. No folder handy? Use **Open Folder ▾ → Open Sample Project** for a small website that lives in memory.
5. Come back later and the bar under the title bar offers your last folder: **Reopen** puts it
   back, along with the files you had open and the line each one was on.

Firefox and Safari do not have the File System Access API — there is no way for any website to
write to your disk in those browsers — so a folder opens **read-only** there. Your edits are kept
in the editor and **Save Folder** packs the whole folder back into `<folder>.zip` for you to unzip
over the original. See [Saving back where it came from](#saving-back-where-it-came-from).

### Saving back where it came from

The point of this part is simple: what you edited should end up in the folder it came from, not
in a pile in your Downloads folder. How that happens depends on what your browser allows.

**A folder you opened (Chrome, Edge, Opera, Brave).** `Ctrl+S` writes straight into the same
file, in the same subfolder, of the same folder on your disk. Nothing to think about.

**Coming back later.** The browser can hand out a *handle* to a folder you picked, and a handle
still points at that folder tomorrow. Online SVS keeps the last one in your browser's own
database, so on your next visit a bar appears under the title bar:

> 📂 Last folder: **hello** · 3 files open   [ Reopen ] [ Forget ]

**Reopen** opens `hello` again, puts back the tabs you had and sets each cursor where you left
it; saving then writes into `hello` exactly as before. It needs the click — Chrome asks for
permission again on every visit and will only ask during a real click, which is also why nothing
reopens by itself. **Forget** wipes it from the browser; your folder is not touched. The same
entry lives in the **Open Folder ▾** menu once the bar has been dismissed.

**The scratch file.** It belongs to no folder, so the first `Ctrl+S` asks where to put it. After
that it has a home: the tab stops saying `untitled` and shows the real file name, and every later
`Ctrl+S` writes straight back to that file — including after a refresh. **Open Folder ▾ → Save
As…** (or `Ctrl+Shift+S` in scratch mode) moves it somewhere else. Changing the language lets go
of the home, because `main.cpp` should not quietly start receiving Python.

**A folder opened from a zip.** Its files are unpacked into the editor, so saving a tab does not
reach your disk on its own — the status bar says **· not on your disk yet** until you use **Save
Folder**. That packs the whole project back up as a zip *of the same shape it arrived in*: a zip
that held `hello/index.html` gets `hello/index.html` back, and one whose files sat at its root
stays flat, so a zip never gains a folder by being opened here. In Chrome, Edge, Opera and Brave
it overwrites the very `.zip` you opened (the browser asks once); elsewhere it downloads the zip
under its original name for you to put back yourself.

**Firefox and Safari, and the sample project.** These cannot be written to at all, so saving keeps
the edit in the editor's copy of the folder and the status bar says **· not on your disk yet** in
yellow until you do something about it. That something is **Save Folder** — the folder item in the
status bar, or **Open Folder ▾ → Save Folder as .zip…** — which downloads `hello.zip` containing
`hello/` with every file in its own subfolder. Unzip it next to the original and everything lands
back where it started. Closing the folder or the tab with edits still waiting warns you first.
Save Folder works in Chrome too, as a quick way to take a copy of the whole folder.

The zip is written by `js/fs/zip.js` in about ninety lines, with no library. Entries are stored
rather than compressed, so the file is a little larger than a normal zip but every unzip program
reads it.

### Opening a zip

There are three ways in, and all three end up in the same place — the files open as a folder,
and **Save Folder** puts them back:

- **Drop a `.zip` anywhere on the page.** An overlay appears while you drag, so you know what
  letting go will do.
- **Open Folder ▾ → Open Zip File…**
- **Click a `.zip` inside a folder you already have open.** It asks first, because the zip takes
  that folder's place.

A zip almost always holds one folder — `hello.zip` unzips to `hello/index.html` — so that folder
becomes the project root and `index.html` is right where you expect it. A zip with several things
at the top level has no such folder to peel off, and keeps its own name instead. The `__MACOSX`
folder that macOS hides inside every zip it makes is left out, along with `node_modules` and
`.git`, exactly as when you open a folder.

The reading is done by `js/fs/unzip.js`, the other half of `js/fs/zip.js` and about as long.
A zip is read from the back: the record at the very end says where the list of files is, and
that list says where each file's bytes are, so nothing has to be guessed at. Two kinds of entry
cover every zip you are likely to meet — plain *stored* bytes, and *deflate*, which is what
Windows, macOS and 7-Zip produce. Deflate is undone by `DecompressionStream`, which the browser
already has, so there is still no library. Every file's checksum is checked as it comes out, and
a zip that is damaged, password-protected or in the Zip64 format says so plainly and leaves the
folder you had open alone.

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

### Running programs

1. Open a file, or write one in the scratch editor, and press **Run** or **Ctrl+Enter**.
2. The **Output** tab shows what your program printed. Compiler messages and anything the
   program wrote to its error stream appear in red, followed by the exit code and how long it took.
3. If your program reads input, type it in the **Input** tab first, one value per line. It is
   handed to the program the moment it starts, which is how OnlineGDB's non-interactive mode
   works: a program cannot ask you for more input while it is running.
4. Pressing the button again while a program is running stops waiting for the result.

Languages: C, C++, Python, JavaScript, TypeScript, Java, C#, Go, Rust, PHP, Ruby, Kotlin,
Swift, Bash and Lua. In a folder, the language comes from the file extension. Java files are
named after their public class automatically, because the Java compiler insists on it.

**Which files are sent.** The file you run always goes. Source files of the same kind sitting
beside it go too, so `#include "utils.h"` and `import helper` find what they need. Three kinds
of neighbour are deliberately held back: a file that defines its own `main`, so a folder full
of separate exercises still compiles; data files such as `.json`, because that is where
configuration and keys tend to live; and anything whose name suggests a secret, such as `.env`,
`api_key.js` or a `.pem`. Every file that does get sent is named in the Output tab before the
program runs, so nothing leaves your machine without you seeing it listed.

Where the code runs: Online SVS has no server, so **Run** sends the file to
[Piston](https://github.com/engineer-man/piston), a free public service that compiles and runs
it in a sandbox and sends back the output. That one request is the only time your code leaves
your browser, and it happens only when you press Run. Piston does not keep your code, but if
you would rather it never left your machine at all, run your own Piston and change `pistonUrl`
in `js/config.js`.

Two limits worth knowing: the public service allows only a few runs per second, so a rapid
second press may ask you to wait, and programs are stopped after a few seconds of running.

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
| Ctrl + Enter | Run the current file |
| Ctrl + S | Save the current file |
| Ctrl + Shift + S | Save all files — in the scratch file, Save As… |
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

## Deploy to Vercel

The site is static and has no build step, so Vercel serves the repository root as it is.

1. On <https://vercel.com/new>, import this repository.
2. Framework Preset **Other**, and leave Build Command and Output Directory empty.
3. Deploy. Vercel serves it over `https://`, which the live server's Service Worker requires.

`vercel.json` does three things, all of them deliberate:

- Sends any `/live/...` address that reaches the server to `live-fallback.html`. A hard reload
  bypasses the Service Worker, so without this the "Open in new tab" preview URL would land on
  Vercel's own 404 page. While the worker is running it answers first and this never applies.
- Keeps `sw.js`, `js/` and `css/` on `must-revalidate` instead of `immutable`. There is no build
  step, so the file names never change; `immutable` would leave visitors on old code after a
  deploy. Revalidating costs a 304.
- Deliberately does **not** set `cleanUrls`: it strips `.html` from addresses, which the live
  preview needs to keep.

## Project structure

```
index.html            the app shell (title bar, activity bar, sidebar, editor, preview, panel, status bar)
sw.js                 the Service Worker that serves the live preview from the browser cache
live-fallback.html    shown when a /live/ address reaches the server instead of the worker
vercel.json           rewrites and cache headers for the Vercel deployment
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
js/runner.js          Run button: talks to the Piston service and renders the output
js/recent.js          remembers the last folder and its tabs; the "Reopen hello" bar
js/saving.js          the scratch file's home on disk, and Save Folder as a zip
js/dialog.js          confirmation dialog (native <dialog>) with verb-first buttons
js/toast.js           notifications; errors stay until dismissed
js/statusbar.js       the blue status bar
js/languages.js       the languages you can write and run, starter programs, companion-file rules
js/fs/index.js        one API for files; native.js = File System Access, memory.js = in-memory fallback + sample
js/fs/handles.js      stores folder and file handles in IndexedDB so they survive a visit
js/fs/zip.js          builds a .zip in the browser, no library (uncompressed entries)
js/fs/unzip.js        reads a .zip back, stored and deflated, no library
js/drop.js            drag a .zip onto the window to open it
tests/                automated browser test (see below)
```

## Updating Monaco

Monaco (the VS Code editor) is loaded from the jsDelivr CDN, so the first load needs internet.

**Its version is pinned by hand.** `MONACO_VERSION` at the top of `js/config.js` is the only
place it is written down: no package manager tracks it, so nothing will tell you when it is out
of date. Whenever you update this project, check
<https://github.com/microsoft/monaco-editor/releases> and decide whether to bump that constant,
then reload the site and confirm the editor still starts. `tests/package.json` pins the same
version for the offline copy the test uses; keep the two in step.

`CONFIG.monacoBase` reads `window.SVS_MONACO_BASE` first, so pointing the app at a self-hosted
copy of Monaco later is a one-line change and needs no other edits.

## Automated test

`tests/smoke.spec.mjs` starts a local server, opens the app in headless Chromium and clicks
through the main features: scratch mode, folders, keyboard navigation, the confirmation dialog,
the live server (preview, CSS hot swap, pausing on errors, the new-tab URL, 404 page, stop),
the Run button against a stand-in for the Piston service, saving work back where it came from
(the zip a folder is packed into, the scratch file's home on disk, the reopen bar and putting
tabs back with their cursors), and opening a folder out of a zip — a compressed one the test
builds itself, since the app's own writer never makes one — including the folder it peels off,
the `__MACOSX` it leaves out, a zip inside a zip, and writing the edits back in the shape they
arrived in.

Three things the browser will not let a test drive: the folder picker, the Save dialog and
dropping a file on the window, since all three need a real person — a drop a script stages is
marked untrusted, and the app ignores those on purpose. The pickers are stood in for, and
opening a folder or a zip without them goes through the debug hook (`window.SVS`, only present
with `?debug`).

```bash
cd tests
npm install                 # playwright, http-server and a local copy of Monaco
npx playwright install chromium   # once, downloads the browser
npm test
```

## Privacy

- Files are read from and written to **your** disk through the browser's File System Access API.
- The scratch file and your settings are kept in **your browser's** localStorage.
- So that your last folder can be offered again, **your browser's** IndexedDB keeps the *handle*
  it gave out for that folder (and for the scratch file's home, if you gave it one). A handle is
  not a path and holds nothing readable: it only means anything inside your own browser, it is
  never sent anywhere, and the browser asks your permission again on every visit before it opens
  anything. **Forget** on the reopen bar deletes it.
- While the live server runs, copies of your files sit in **your browser's** cache so the preview can load them. They are removed when you stop the server, close the folder or reload the app.
- Pressing **Run** is the one exception: the file you are running, the helper files beside it and your Input text are sent to the Piston service so it can run them. The Output tab names every file that was sent. Data files and anything that looks like a secret are held back. Nothing is sent until you press Run.
- There is no account, no tracking and no server-side storage of any kind.

// tests/smoke.spec.mjs — end-to-end smoke test.
// Starts a static server for the repository, opens the app in headless Chromium and clicks
// through the main features, including the live server. Monaco is served from the local npm
// copy so the test also works without internet access.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { deflateRawSync, deflateSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.PORT || 8123);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(here, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const localMonaco = path.join(here, 'node_modules', 'monaco-editor', 'min', 'vs', 'loader.js');
if (!existsSync(localMonaco)) {
  console.error('Run `npm install` inside tests/ first (it downloads a local copy of Monaco).');
  process.exit(1);
}

/* ---------- static server ---------- */
const serverBin = path.join(here, 'node_modules', 'http-server', 'bin', 'http-server');
const server = spawn(process.execPath, [serverBin, root, '-p', String(PORT), '-c-1', '--silent'], { stdio: 'ignore' });

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/index.html`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('The static server did not start.');
}

/* ---------- tiny test runner ---------- */
const results = [];
let currentStep = 'startup';
// Set once the page exists: a step that fails halfway can leave a modal dialog or a
// right-click menu open, and everything behind a modal dialog is inert — so one broken
// assertion would otherwise be reported as twenty broken features.
let afterEachStep = null;
const startedAt = Date.now();
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
async function step(name, fn) {
  currentStep = name;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${elapsed()})`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name} (${elapsed()})\n    ${err.message}`);
  }
  if (afterEachStep) {
    try {
      await afterEachStep();
    } catch { /* the page may be gone; the step's own result is what matters */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a zip the way Windows, macOS and 7-Zip do: entries *deflated*, not stored. The app's
 * own writer only stores, so a zip made here is the only way the test can prove that reading
 * a genuinely compressed zip works. Written by hand for the same reason as readZip below.
 */
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let v = i;
  for (let bit = 0; bit < 8; bit++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
  crcTable[i] = v >>> 0;
}
/** The checksum both a zip entry and a PNG chunk are stamped with. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/**
 * A real PNG, built by hand, so the image tab has something a browser will genuinely decode
 * and report the size of. A made-up file with a PNG signature would only prove the error path.
 */
function makePng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // eight bits per channel
  header[9] = 2;  // truecolour (red, green, blue)
  const rows = Array.from({ length: height }, () => (
    // Each row starts with its filter byte, then three bytes per pixel.
    Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x40)])
  ));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeZip(entries) {
  const body = [];
  const directory = [];
  let offset = 0;
  for (const [rawName, contents] of Object.entries(entries)) {
    const isDir = rawName.endsWith('/');
    const name = Buffer.from(rawName, 'utf8');
    const data = isDir ? Buffer.alloc(0) : Buffer.from(contents);
    const packed = isDir ? Buffer.alloc(0) : deflateRawSync(data);
    const crc = data.length ? crc32(data) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);           // the name below is UTF-8
    local.writeUInt16LE(isDir ? 0 : 8, 8);    // 8 = deflated
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    body.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(isDir ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(isDir ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += 30 + name.length + packed.length;
  }

  const end = Buffer.alloc(22);
  const count = Object.keys(entries).length;
  const directorySize = directory.reduce((total, part) => total + part.length, 0);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, ...directory, end]);
}

/** Hand a zip to the page: the picker cannot be clicked, but bytes can be passed in. */
const toBase64 = (buffer) => buffer.toString('base64');

/**
 * Read a zip the app produced. Every entry is *stored* (never compressed), so walking the
 * local file headers back to back is enough — no inflate, and no zip library in the tests.
 */
function readZip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const entries = new Map();
  let at = 0;
  while (at + 30 <= buffer.length && view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = buffer.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extraLength;
    entries.set(name, buffer.subarray(start, start + size));
    at = start + size;
  }
  return entries;
}

/* ---------- the test ---------- */
let browser;
const pageErrors = [];
try {
  await waitForServer();
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // Copy Path writes to the clipboard, and the test reads it back to check what landed there.
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  // A stand-in for the Piston code-running service. The sandbox has no internet access, and
  // even with it we would not want the tests hitting a public service. `pistonMode` lets each
  // step decide what the service answers; `pistonCalls` records what we sent it.
  const pistonCalls = [];
  let pistonMode = 'ok';
  let pistonDelay = 0;
  const RUNTIMES = [
    { language: 'python', version: '2.7.18', aliases: [] },
    { language: 'python', version: '3.12.0', aliases: ['py', 'python3'] },
    { language: 'c++', version: '10.2.0', aliases: ['cpp', 'g++'] },
    { language: 'javascript', version: '20.11.1', aliases: ['node', 'js'] },
    { language: 'java', version: '15.0.2', aliases: [] },
  ];
  await context.route('**/piston/runtimes', (route) => {
    if (pistonMode === 'offline') return route.abort('failed');
    return route.fulfill({ json: RUNTIMES });
  });
  await context.route('**/piston/execute', async (route) => {
    // Read this request's own body up front. A delayed run is deliberately abandoned by one
    // of the steps below, so this handler can still be sleeping when a later step resets
    // `pistonCalls` — reading the answer back out of that shared list afterwards would then
    // pick up the wrong call, or none at all.
    const sent = JSON.parse(route.request().postData());
    pistonCalls.push(sent);
    const reply = (response) => route.fulfill(response).catch(() => {
      /* the page navigated away while we were sleeping; nothing is waiting for this */
    });
    if (pistonDelay) await new Promise((r) => setTimeout(r, pistonDelay));
    if (pistonMode === 'ratelimit') {
      return reply({ status: 429, json: { message: 'Requests limited to 5 requests per 1s' } });
    }
    if (pistonMode === 'compile-error') {
      return reply({
        json: {
          language: 'c++',
          version: '10.2.0',
          compile: { stdout: '', stderr: "main.cpp:3:5: error: expected ';' before '}'", code: 1, signal: null },
          run: { stdout: '', stderr: '', code: 0, signal: null },
        },
      });
    }
    if (pistonMode === 'timeout-kill') {
      return reply({
        json: { language: 'python', version: '3.12.0', run: { stdout: '', stderr: '', code: null, signal: 'SIGKILL' } },
      });
    }
    return reply({
      json: {
        language: sent.language,
        version: sent.version,
        run: { stdout: `ran ${sent.files[0].name}\nstdin was: ${sent.stdin}\n`, stderr: '', code: 0, signal: null },
      },
    });
  });

  const page = await context.newPage();
  page.on('pageerror', (err) => {
    if (pageErrors.length < 50) pageErrors.push({ step: currentStep, message: err.message, stack: err.stack }); // capped
  });
  await page.addInitScript((base) => {
    window.SVS_MONACO_BASE = base;
    window.SVS_DEBUG = true; // exposes window.SVS for the checks below
  }, `${BASE}/tests/node_modules/monaco-editor/min`);

  const editorValue = () => page.evaluate(() => window.SVS.getEditor().getValue());
  const activeTabName = () => page.textContent('.tab.active .tab-name');
  const liveStatus = () => page.textContent('#status-live-text');
  const waitForLiveStatus = (text) => page.waitForFunction(
    (t) => document.getElementById('status-live-text').textContent.includes(t), text, { timeout: 20000 },
  );
  const previewFrame = () => page.frames().find((f) => f.url().includes('/live/'));
  // Never hand Playwright handles to assert(): on failure it would try to print their whole object graph.
  const exists = async (selector) => (await page.$(selector)) !== null;

  // Close anything left hanging over the page after each step (see afterEachStep above).
  afterEachStep = async () => {
    if (await page.$('.context-menu:not([hidden])')) await page.keyboard.press('Escape');
    await page.evaluate(() => {
      for (const box of document.querySelectorAll('dialog[open]')) box.close();
      // Sticky notifications (errors, and questions with buttons) would otherwise still be on
      // screen when the next step looks at what it has been told.
      for (const close of document.querySelectorAll('.toast .toast-close')) close.click();
    });
  };

  /**
   * Show the Explorer. Clicking its icon in the activity bar is not the same thing: when the
   * Explorer is already the view on show, that click folds the sidebar away, exactly as in
   * VS Code — which then hides the very tree the next line wants to click.
   */
  const showExplorer = () => page.evaluate(() => window.SVS.runCommand('explorer'));

  console.log('Online SVS smoke test');

  await step('page loads and Monaco mounts', async () => {
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
    assert.equal(await page.textContent('.app-name'), 'Online SVS');
    await page.waitForSelector('#btn-open-folder:not([disabled])');
  });

  await step('scratch file starts as C++ with a starter program', async () => {
    assert.equal(await activeTabName(), 'untitled.cpp');
    assert.match(await editorValue(), /Hello, World!/);
    assert.equal(await page.inputValue('#language-select'), 'cpp');
  });

  await step('changing the language swaps the scratch file and remembers it', async () => {
    await page.selectOption('#language-select', 'python');
    await page.waitForSelector('.tab.active:has-text("untitled.py")');
    assert.match(await editorValue(), /print\("Hello, World!"\)/);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('svs.scratch')));
    assert.equal(saved.language, 'python');
  });

  await step('scratch text survives a page reload', async () => {
    await page.evaluate(() => window.SVS.getEditor().setValue('print("remember me")\n'));
    await sleep(500); // autosave debounce
    await page.reload();
    await page.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
    await page.waitForSelector('#btn-open-folder:not([disabled])');
    assert.equal(await activeTabName(), 'untitled.py');
    assert.match(await editorValue(), /remember me/);
  });

  await step('open the sample project: explorer shows it and index.html opens', async () => {
    await page.click('#btn-open-menu');
    await page.click('button[data-command="open-sample"]');
    await page.waitForSelector('.tree-row[data-path="index.html"]');
    await page.waitForSelector('.tab.active:has-text("index.html")');
    assert.equal(await exists('#app.mode-folder'), true, 'app should be in folder mode');
    assert.equal(await exists('.tab.scratch'), false, 'scratch tab should be gone');
    assert.match(await page.textContent('#status-folder'), /sample-site/);
  });

  await step('expanding a folder and clicking a file opens a tab', async () => {
    await page.click('.tree-row[data-path="css"]');
    await page.click('.tree-row[data-path="css/style.css"]');
    await page.waitForSelector('.tab.active:has-text("style.css")');
    assert.match(await editorValue(), /--accent/);
    assert.equal(await page.textContent('#status-language'), 'CSS');
    assert.equal(await page.textContent('#status-cursor'), 'Ln 1, Col 1');
  });

  await step('typing marks the tab dirty and Ctrl+S saves it', async () => {
    await page.click('.monaco-editor .view-lines');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n/* edited in the test */');
    await page.waitForSelector('.tab.active.dirty');
    await page.keyboard.press('Control+s');
    await page.waitForSelector('.tab.active:not(.dirty)');
    const stored = await page.evaluate(() => window.SVS.fs.readText('css/style.css'));
    assert.match(stored, /edited in the test/);
  });

  await step('a folder the browser cannot write to says the edit is not on the disk yet', async () => {
    const folder = await page.textContent('#status-folder');
    assert.match(folder, /not on your disk yet/, 'the status bar must not imply the edit reached the disk');
    assert.match(await page.getAttribute('#status-folder', 'title'), /unzip it over the original/);
  });

  await step('Save Folder packs the folder back up, keeping every file in its subfolder', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#status-folder'), // the status bar item is the shortcut for Save Folder
    ]);
    assert.equal(download.suggestedFilename(), 'sample-site.zip');

    const entries = readZip(readFileSync(await download.path()));
    // Everything sits under one folder named after the original, so unzipping it next to
    // the original merges the files straight back in.
    assert.ok(entries.has('sample-site/'), 'the zip should carry the folder itself');
    assert.ok(entries.has('sample-site/css/'), 'subfolders should survive');
    assert.ok(entries.has('sample-site/index.html'), `index.html missing, got ${[...entries.keys()]}`);
    assert.match(
      entries.get('sample-site/css/style.css').toString('utf8'),
      /edited in the test/,
      'the edit must travel back inside the zip, at its original path',
    );
    await page.waitForFunction(() => !document.getElementById('status-folder').textContent.includes('not on your disk'));
  });

  await step('new file from the explorer header', async () => {
    await page.click('.tree-header-name'); // select the root folder
    await page.hover('#view-explorer');
    await page.click('[data-action="new-file"]');
    await page.fill('.tree-input', 'notes.txt');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tree-row[data-path="notes.txt"]');
    await page.waitForSelector('.tab.active:has-text("notes.txt")');
  });

  await step('keyboard: arrow keys move through the tree and Enter opens a file', async () => {
    await page.focus('.tree-row[data-path="about.html"]');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.path), 'index.html');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.path), 'about.html');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tab.active:has-text("about.html")');
    await page.focus('.tree-row[data-path="img"]');
    await page.keyboard.press('ArrowRight'); // expands the folder
    await page.waitForSelector('.tree-row[data-path="img/logo.svg"]');
    assert.equal(await page.getAttribute('.tree-row[data-path="img"]', 'aria-expanded'), 'true');
  });

  await step('keyboard: Left/Right arrows switch editor tabs', async () => {
    await page.focus('.tab.active');
    const before = await activeTabName();
    await page.keyboard.press('ArrowLeft');
    const after = await activeTabName();
    assert.notEqual(before, after);
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('tab')), 'focus stays on a tab');
  });

  await step('Ctrl+P finds a file by part of its name and opens it', async () => {
    await page.keyboard.press('Control+p');
    await page.waitForSelector('dialog.quick-open[open]');
    await page.fill('.quick-input', 'sty');
    await page.waitForFunction(
      () => document.querySelector('.quick-item.selected .quick-name')?.textContent === 'style.css',
    );
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tab.active:has-text("style.css")');
    assert.equal(await page.evaluate(() => document.querySelector('dialog.quick-open').open), false);
  });

  await step('Ctrl+P matches letters that are not next to each other, and Escape closes it', async () => {
    await page.keyboard.press('Control+p');
    await page.waitForSelector('dialog.quick-open[open]');
    await page.fill('.quick-input', 'cst'); // c-s-t, spread across "css/style.css"
    await page.waitForFunction(
      () => document.querySelector('.quick-item.selected .quick-name')?.textContent === 'style.css',
    );
    // c and s are in "css", t is in "style.css": every letter that matched is marked.
    assert.equal(await page.locator('.quick-item.selected .quick-dir mark').count(), 2);
    assert.equal(await page.locator('.quick-item.selected .quick-name mark').count(), 1);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.quick-open').open);
    // Closed has to mean gone from the screen, not merely "not open": a stray `display` rule
    // would beat the browser's own and leave the palette hanging over the editor.
    assert.equal(await page.locator('dialog.quick-open').isVisible(), false, 'the palette must disappear');
  });

  await step('Search finds text in a file that is not open, and a result jumps to its line', async () => {
    // app.js has never been opened in this run, so a match in it can only come from the disk.
    assert.equal(await page.locator('.tab:has-text("app.js")').count(), 0, 'app.js must not be open yet');
    await page.keyboard.press('Control+Shift+F');
    await page.waitForSelector('#search-input');
    await page.fill('#search-input', 'counter');
    await page.waitForSelector('.search-match', { timeout: 10000 });
    assert.match(await page.textContent('#search-status'), /\d+ results? in \d+ files?/);

    const names = await page.$$eval('.search-file-name', (all) => all.map((n) => n.textContent));
    assert.ok(names.includes('app.js'), `app.js should be among the results, got ${names}`);

    const firstFile = await page.textContent('.search-file .search-file-name');
    const firstLine = await page.textContent('.search-match .search-line');
    assert.equal(await page.locator('.search-match .search-text mark').count() > 0, true, 'the hit should be highlighted');
    await page.click('.search-match');
    await page.waitForSelector(`.tab.active:has-text("${firstFile}")`);
    assert.match(await page.textContent('#status-cursor'), new RegExp(`^Ln ${firstLine},`));
  });

  await step('Search: Match case narrows it down, and a broken pattern says so', async () => {
    await page.fill('#search-input', 'COUNTER');
    await page.waitForSelector('.search-match', { timeout: 10000 });
    await page.click('.search-toggle[data-toggle="matchCase"]');
    await page.waitForFunction(
      () => document.getElementById('search-status').textContent.includes('No results'),
      null, { timeout: 10000 },
    );
    await page.click('.search-toggle[data-toggle="matchCase"]'); // back off

    await page.click('.search-toggle[data-toggle="regex"]');
    await page.fill('#search-input', 'count[er');
    await page.waitForFunction(
      () => document.getElementById('search-status').classList.contains('error'),
      null, { timeout: 10000 },
    );
    assert.match(await page.textContent('#search-status'), /not a valid regular expression/);

    await page.fill('#search-input', 'count(er|down)');
    await page.waitForSelector('.search-match', { timeout: 10000 });
    await page.click('.search-toggle[data-toggle="regex"]');
    await page.fill('#search-input', '');
    await showExplorer();
  });

  await step('renaming a file follows it in the tree, in its tab and in unsaved changes', async () => {
    await showExplorer();
    await page.click('.tree-row[data-path="notes.txt"]');
    await page.waitForSelector('.tab.active:has-text("notes.txt")');
    await page.click('.monaco-editor .view-lines');
    await page.keyboard.type('a thought not yet saved');
    await page.waitForSelector('.tab.active.dirty');

    await page.click('.tree-row[data-path="notes.txt"]', { button: 'right' });
    await page.waitForSelector('.context-menu .context-item:has-text("Rename")');
    await page.click('.context-menu .context-item:has-text("Rename")');
    await page.fill('.tree-input', 'thoughts.md');
    await page.keyboard.press('Enter');

    await page.waitForSelector('.tree-row[data-path="thoughts.md"]');
    assert.equal(await page.locator('.tree-row[data-path="notes.txt"]').count(), 0, 'the old name should be gone');
    await page.waitForSelector('.tab.active:has-text("thoughts.md")');
    assert.equal(await exists('.tab.active.dirty'), true, 'unsaved changes must survive the rename');
    assert.match(await editorValue(), /a thought not yet saved/);
    assert.equal(await page.evaluate(() => window.SVS.fs.exists('thoughts.md')), true);
    assert.equal(await page.evaluate(() => window.SVS.fs.exists('notes.txt')), false);
    // The language follows the new extension, which is what the rebuilt model is for.
    assert.equal(await page.textContent('#status-language'), 'Markdown');
  });

  await step('renaming a file leaves the cursor in the file you are looking at alone', async () => {
    await showExplorer();
    await page.click('.tree-row[data-path="index.html"]');
    await page.waitForSelector('.tab.active:has-text("index.html")');
    await page.evaluate(() => window.SVS.getEditor().setPosition({ lineNumber: 9, column: 3 }));
    await page.waitForFunction(() => document.getElementById('status-cursor').textContent === 'Ln 9, Col 3');

    await page.click('.tree-row[data-path="thoughts.md"]', { button: 'right' });
    await page.click('.context-menu .context-item:has-text("Rename")');
    await page.fill('.tree-input', 'thoughts2.md');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tree-row[data-path="thoughts2.md"]');

    assert.equal(await page.textContent('#status-cursor'), 'Ln 9, Col 3', 'the cursor must not jump');
    assert.equal(await activeTabName(), 'index.html', 'the tab on screen must not change');
    // Put the name back, so the steps below read as they were written.
    await page.click('.tree-row[data-path="thoughts2.md"]', { button: 'right' });
    await page.click('.context-menu .context-item:has-text("Rename")');
    await page.fill('.tree-input', 'thoughts.md');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tree-row[data-path="thoughts.md"]');
  });

  await step('renaming onto a name that is taken is refused', async () => {
    await page.click('.tree-row[data-path="thoughts.md"]', { button: 'right' });
    await page.click('.context-menu .context-item:has-text("Rename")');
    await page.fill('.tree-input', 'index.html');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast.error');
    assert.match(await page.textContent('.toast.error .toast-text'), /already exists/);
    await page.waitForSelector('.tree-row[data-path="thoughts.md"]'); // nothing moved
    await page.click('.toast.error .toast-close');
  });

  await step('Copy Path copies the path inside the folder', async () => {
    await showExplorer();
    await page.click('.tree-row[data-path="css/style.css"]', { button: 'right' });
    await page.click('.context-menu .context-item:has-text("Copy Path")');
    await page.waitForSelector('.toast.success');
    assert.match(await page.textContent('.toast.success .toast-text'), /Copied "css\/style\.css"/);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'css/style.css');
  });

  await step('deleting a file asks first, then takes its tab with it', async () => {
    await page.click('.tree-row[data-path="thoughts.md"]', { button: 'right' });
    await page.click('.context-menu .context-item:has-text("Delete")');
    await page.waitForSelector('dialog.dialog[open]');
    assert.match(await page.textContent('.dialog-title'), /Delete file "thoughts\.md"\?/);
    assert.equal(await page.textContent('.dialog-confirm'), 'Delete file');
    await page.click('.dialog-confirm');

    await page.waitForFunction(() => !document.querySelector('.tree-row[data-path="thoughts.md"]'));
    assert.equal(await page.locator('.tab:has-text("thoughts.md")').count(), 0, 'the tab goes with the file');
    assert.equal(await page.evaluate(() => window.SVS.fs.exists('thoughts.md')), false);
  });

  await step('deleting can be called off, and then nothing happens', async () => {
    await page.click('.tree-row[data-path="about.html"]', { button: 'right' });
    await page.click('.context-menu .context-item:has-text("Delete")');
    await page.waitForSelector('dialog.dialog[open]');
    await page.click('.dialog-cancel');
    await page.waitForSelector('.tree-row[data-path="about.html"]');
    assert.equal(await page.evaluate(() => window.SVS.fs.exists('about.html')), true);
  });

  await step('the right-click menu can be reached from the keyboard', async () => {
    await page.focus('.tree-row[data-path="index.html"]');
    await page.keyboard.press('Shift+F10');
    await page.waitForSelector('.context-menu .context-item');
    // The first item is focused, so Arrow keys and Enter are enough to use it.
    assert.match(await page.evaluate(() => document.activeElement.textContent), /Rename/);
    await page.keyboard.press('ArrowDown');
    assert.match(await page.evaluate(() => document.activeElement.textContent), /Delete/);
    await page.keyboard.press('Escape');
    assert.equal(await exists('.context-menu:not([hidden])'), false, 'Escape should close the menu');
    assert.equal(
      await page.evaluate(() => document.activeElement.dataset.path),
      'index.html',
      'the focus should come back to the row it was opened from',
    );
  });

  await step('the live refresh delay can be chosen in Settings', async () => {
    await page.click('#btn-settings');
    await page.selectOption('#setting-live-delay', '250');
    assert.equal(await page.evaluate(() => window.SVS.state.settings.liveRefreshDelay), 250);
    assert.equal(
      await page.evaluate(() => JSON.parse(localStorage.getItem('svs.settings')).liveRefreshDelay),
      250,
      'the choice should be remembered in this browser',
    );
    await page.selectOption('#setting-live-delay', '750'); // back to the default for the live tests
    await showExplorer();
  });

  await step('Go Live serves the sample site in the preview panel', async () => {
    await page.click('.tree-row[data-path="index.html"]');
    await page.waitForSelector('.tab.active:has-text("index.html")');
    await page.click('#btn-live');
    await page.waitForSelector('dialog[open]'); // first Go Live asks for confirmation
    assert.match(await page.textContent('dialog[open] .dialog-message'), /same access as this editor/);
    await page.click('dialog[open] .dialog-confirm');
    await page.waitForSelector('#preview-frame:not([hidden])');
    const heading = page.frameLocator('#preview-frame').locator('h1');
    await heading.waitFor({ timeout: 15000 });
    assert.match(await heading.textContent(), /Hello from the sample site/);
    await waitForLiveStatus('Live: on');
    assert.equal(await page.getAttribute('#btn-live', 'aria-pressed'), 'true');
    assert.match(await page.textContent('#preview-address'), /live\/index\.html/);
    assert.match(await page.getAttribute('#preview-open', 'href'), /\/live\/index\.html$/);
  });

  await step('a CSS edit hot-swaps the stylesheet in the preview without errors', async () => {
    await page.click('.tree-row[data-path="css/style.css"]');
    await page.waitForSelector('.tab.active:has-text("style.css")');
    await page.evaluate(() => {
      const editor = window.SVS.getEditor();
      editor.setValue(editor.getValue().replace('--accent: #2563eb', '--accent: rgb(255, 0, 0)'));
    });
    await previewFrame().waitForFunction(
      () => getComputedStyle(document.querySelector('nav a.active')).color === 'rgb(255, 0, 0)',
      null,
      { timeout: 15000 },
    );
    assert.equal(await liveStatus(), 'Live: on');
    await page.screenshot({ path: path.join(SHOTS, 'phase2-live.png') });
  });

  await step('a JavaScript error pauses the live refresh and shows up in Problems', async () => {
    await page.click('.tree-row[data-path="js"]');
    await page.click('.tree-row[data-path="js/app.js"]');
    await page.waitForSelector('.tab.active:has-text("app.js")');
    await page.evaluate(() => window.SVS.getEditor().setValue('function broken( {\n'));
    await waitForLiveStatus('paused');
    await page.waitForSelector('#problems-count:not([hidden])');
    assert.ok(Number(await page.textContent('#problems-count')) >= 1);
    await page.click('.panel-tab[data-tab="problems"]');
    assert.match(await page.textContent('#problems-list'), /app\.js/);

    // The served file must still be the last good version.
    const probe = await context.newPage();
    await probe.goto(`${BASE}/live/js/app.js`);
    assert.match(await probe.evaluate(() => document.body.innerText), /addEventListener/);
    await probe.close();
  });

  await step('fixing the error resumes the live refresh', async () => {
    await page.evaluate(() => window.SVS.getEditor().setValue('console.log("fixed");\n'));
    await waitForLiveStatus('Live: on');
    const probe = await context.newPage();
    await probe.goto(`${BASE}/live/js/app.js`);
    assert.match(await probe.evaluate(() => document.body.innerText), /fixed/);
    await probe.close();
  });

  await step('a back/forward-cached page keeps its served files', async () => {
    // pagehide fires both when the page is discarded and when it goes into the back/forward
    // cache to come back alive later. Only the first may wipe the files the preview serves.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await sleep(400); // long enough for the (unwanted) caches.delete to have finished
    const probe = await context.newPage();
    const res = await probe.goto(`${BASE}/live/index.html`);
    assert.equal(res.status(), 200, 'a bfcache pagehide must not clear the live cache');
    await probe.close();
  });

  await step('closing a tab with unsaved changes shows a confirmation dialog', async () => {
    await page.click('.tab.active .tab-close');
    await page.waitForSelector('dialog[open]');
    assert.match(await page.textContent('dialog[open] .dialog-title'), /without saving/);
    await page.click('dialog[open] .dialog-confirm');
    await page.waitForFunction(() => !document.querySelector('dialog').open);
    await page.waitForSelector('.tab:has-text("app.js")', { state: 'detached' });
  });

  await step('the live URL works in a new tab, injects the reload script, and 404s cleanly', async () => {
    const probe = await context.newPage();
    await probe.goto(`${BASE}/live/about.html`);
    const html = await probe.content();
    assert.match(html, /About this site/);
    assert.match(html, /data-svs-live/);
    const missing = await probe.goto(`${BASE}/live/does-not-exist.html`);
    assert.equal(missing.status(), 404);
    assert.match(await probe.content(), /404/);
    await probe.close();
  });

  await step('Stop Live hides the preview and clears the served files', async () => {
    await page.click('#btn-live-stop');
    await waitForLiveStatus('Live: off');
    assert.equal(await exists('#preview-frame[hidden]'), true, 'preview frame should be hidden');
    const probe = await context.newPage();
    const res = await probe.goto(`${BASE}/live/index.html`);
    assert.equal(res.status(), 404);
    await probe.close();
  });

  await step('Run sends the open folder file and its companions, but not data or secrets', async () => {
    // A helper for the companion rule to pick up, plus two files that must stay put.
    await page.click('.tree-row[data-path="js"]');            // selects the folder
    await page.hover('#view-explorer');
    await page.click('[data-action="new-file"]');
    await page.fill('.tree-input', 'helper.js');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.tree-row[data-path="js/helper.js"]');
    await page.evaluate(async () => {
      const { fs } = window.SVS;
      await fs.createFile('js', 'config.json');
      await fs.writeText('js/config.json', '{"apiKey":"super-secret-value"}');
      await fs.createFile('js', 'api_key.js');
      await fs.writeText('js/api_key.js', 'export const KEY = "super-secret-value";');
    });
    await page.hover('#view-explorer');
    await page.click('[data-action="refresh"]');
    await page.waitForSelector('.tree-row[data-path="js/api_key.js"]');

    await page.click('.tree-row[data-path="js/app.js"]');
    await page.waitForSelector('.tab.active:has-text("app.js")');
    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForSelector('#panel-output:not([hidden])');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });

    assert.equal(pistonCalls.length, 1);
    const sent = pistonCalls[0];
    assert.equal(sent.language, 'javascript');
    assert.equal(sent.version, '20.11.1');
    assert.equal(sent.files[0].name, 'app.js', 'the file being run must come first');
    assert.ok(sent.files.some((f) => f.name === 'helper.js'), 'the companion file must be included');
    const names = sent.files.map((f) => f.name);
    assert.ok(!names.includes('config.json'), 'data files must not be sent');
    assert.ok(!names.includes('api_key.js'), 'a file named like a secret must not be sent');
    const body = JSON.stringify(sent);
    assert.ok(!body.includes('super-secret-value'), 'no secret content may reach the service');
    const output = await page.textContent('#output-text');
    assert.match(output, /Running app\.js with JavaScript 20\.11\.1/);
    assert.match(output, /Also sending from the same folder: helper\.js/);
    assert.match(output, /name suggests it holds secrets/);
    assert.match(output, /Exit code 0/);
  });

  await step('the Input tab is handed to the program as stdin', async () => {
    await page.click('.panel-tab[data-tab="input"]');
    await page.fill('#stdin-input', 'line one\nline two');
    pistonCalls.length = 0;
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });
    assert.equal(pistonCalls[0].stdin, 'line one\nline two');
    assert.match(await page.textContent('#output-text'), /stdin was: line one/);
    // Run switches the panel to Output, so come back to Input before clearing it.
    await page.click('.panel-tab[data-tab="input"]');
    await page.fill('#stdin-input', '');
    await page.click('.panel-tab[data-tab="output"]');
  });

  await step('a compile error is shown and the exit code is not claimed to be zero', async () => {
    pistonMode = 'compile-error';
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('did not compile'), null, { timeout: 20000 });
    const output = await page.textContent('#output-text');
    assert.match(output, /expected ';' before/);
    assert.doesNotMatch(output, /Exit code 0/);
    pistonMode = 'ok';
  });

  await step('a position in the output is a button that jumps to that line', async () => {
    // The stand-in compiler complains about main.cpp:3:5, so give the folder a main.cpp for it
    // to be talking about — a name that matches nothing here must stay plain text.
    await page.evaluate(async () => {
      const { fs } = window.SVS;
      await fs.createFile('', 'main.cpp');
      await fs.writeText('main.cpp', 'int main() {\n  int a = 1;\n  int b = 2\n  return 0;\n}\n');
    });
    await page.hover('#view-explorer');
    await page.click('[data-action="refresh"]');
    await page.click('.tree-row[data-path="main.cpp"]');
    await page.waitForSelector('.tab.active:has-text("main.cpp")');

    pistonMode = 'compile-error';
    await page.click('#btn-run');
    await page.waitForFunction(() => document.querySelector('#output-text .out-link'), null, { timeout: 20000 });
    pistonMode = 'ok';
    assert.equal(await page.textContent('#output-text .out-link'), 'main.cpp:3:5');

    await page.click('.tab:has-text("index.html")'); // look away, so the jump has to do the work
    await page.click('#output-text .out-link');
    await page.waitForSelector('.tab.active:has-text("main.cpp")');
    assert.equal(await page.textContent('#status-cursor'), 'Ln 3, Col 5');
  });

  await step('being rate limited explains itself in plain words', async () => {
    pistonMode = 'ratelimit';
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('few runs per second'), null, { timeout: 20000 });
    pistonMode = 'ok';
  });

  await step('a program stopped by the service says so', async () => {
    pistonMode = 'timeout-kill';
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('SIGKILL'), null, { timeout: 20000 });
    assert.match(await page.textContent('#output-text'), /run too long|too much memory/);
    pistonMode = 'ok';
  });

  await step('running an HTML file points at Go Live instead', async () => {
    await page.click('.tree-row[data-path="index.html"]');
    await page.waitForSelector('.tab.active:has-text("index.html")');
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Go Live'), null, { timeout: 20000 });
  });

  await step('a neighbour with its own main is left out, but headers and helpers travel', async () => {
    await page.evaluate(async () => {
      const { fs } = window.SVS;
      await fs.createFile('', 'exercise1.cpp');
      await fs.writeText('exercise1.cpp', '#include "shapes.h"\nint main() { return area(2); }\n');
      await fs.createFile('', 'exercise2.cpp');
      await fs.writeText('exercise2.cpp', '#include <cstdio>\nint main() { printf("other"); }\n');
      await fs.createFile('', 'shapes.h');
      await fs.writeText('shapes.h', 'int area(int side);\n');
      await fs.createFile('', 'shapes.cpp');
      await fs.writeText('shapes.cpp', '#include "shapes.h"\nint area(int side) { return side * side; }\n');
    });
    await page.hover('#view-explorer'); // the tree's action buttons appear on hover
    await page.click('[data-action="refresh"]');
    await page.waitForSelector('.tree-row[data-path="exercise1.cpp"]');

    await page.click('.tree-row[data-path="exercise1.cpp"]');
    await page.waitForSelector('.tab.active:has-text("exercise1.cpp")');
    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });

    const names = pistonCalls[0].files.map((f) => f.name);
    assert.equal(names[0], 'exercise1.cpp');
    assert.ok(names.includes('shapes.h'), 'the header must be sent');
    assert.ok(names.includes('shapes.cpp'), 'a helper without a main must be sent');
    assert.ok(!names.includes('exercise2.cpp'), 'a neighbour with its own main must be left out');
    assert.equal(pistonCalls[0].language, 'c++');
  });

  await step('pressing Run again while it is running stops waiting, without a second request', async () => {
    pistonDelay = 4000;
    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForSelector('#btn-run.running');
    assert.equal(await page.textContent('.btn-run-label'), 'Running…');
    await page.click('#btn-run');           // second press = stop waiting
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Stopped waiting'), null, { timeout: 20000 });
    await page.waitForSelector('#btn-run:not(.running)');
    assert.equal(pistonCalls.length, 1, 'a second press must not start another run');
    pistonDelay = 0;
  });

  await step('settings: choosing Fira Code changes the editor font', async () => {
    await page.click('#activity-settings');
    await page.selectOption('#setting-font', 'fira-code');
    await sleep(300);
    const family = await page.evaluate(() => window.SVS.getEditor().getRawOptions().fontFamily);
    assert.match(family, /Fira Code/);
    assert.match(await page.textContent('#status-font'), /Fira Code/);
    await page.selectOption('#setting-font', 'default');
  });

  await step('Ctrl+B and Ctrl+J toggle the sidebar and panel', async () => {
    await page.keyboard.press('Control+b');
    assert.equal(await exists('#app.hide-sidebar'), true);
    await page.keyboard.press('Control+b');
    assert.equal(await exists('#app.hide-sidebar'), false);
    await page.keyboard.press('Control+j');
    assert.equal(await exists('#app.hide-panel'), true);
    await page.keyboard.press('Control+j');
    assert.equal(await exists('#app.hide-panel'), false);
  });

  await step('screenshot of the folder mode', async () => {
    await page.click('.activity[data-view="explorer"]');
    await page.click('.tree-row[data-path="index.html"]');
    await page.waitForSelector('.tab.active:has-text("index.html")');
    await sleep(300);
    await page.screenshot({ path: path.join(SHOTS, 'phase1-folder.png') });
  });

  await step('closing the folder returns to the scratch file', async () => {
    await page.click('#btn-open-menu');
    await page.click('button[data-command="close-folder"]');
    await page.waitForSelector('dialog[open]'); // style.css still has unsaved changes
    await page.click('dialog[open] .dialog-confirm');
    await page.waitForSelector('.tab.scratch');
    assert.equal(await activeTabName(), 'untitled.py');
    assert.equal(await exists('#app.mode-scratch'), true);
  });

  await step('the scratch file can go live in HTML mode', async () => {
    await page.evaluate(() => window.SVS.getEditor().setValue(''));
    await page.selectOption('#language-select', 'html');
    await page.waitForSelector('.tab.active:has-text("untitled.html")');
    await page.click('#btn-live');
    const heading = page.frameLocator('#preview-frame').locator('h1');
    await heading.waitFor({ timeout: 15000 });
    assert.match(await heading.textContent(), /Hello, World!/);
    await page.selectOption('#language-select', 'python'); // switching language stops the server
    await waitForLiveStatus('Live: off');
    await page.screenshot({ path: path.join(SHOTS, 'phase1-scratch.png') });
  });

  await step('the scratch file runs, picking the newest version of the language', async () => {
    await page.evaluate(() => window.SVS.getEditor().setValue('print("from the scratch file")\n'));
    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });
    const sent = pistonCalls[0];
    assert.equal(sent.language, 'python');
    assert.equal(sent.version, '3.12.0', 'the newest listed version should win over 2.7.18');
    assert.equal(sent.files[0].name, 'main.py');
    assert.equal(sent.files.length, 1, 'the scratch file has no companions');
    assert.match(await page.textContent('#output-text'), /Running main\.py with Python 3\.12\.0/);
  });

  await step('the scratch file\'s own error positions are clickable too', async () => {
    // The service is given the scratch file under a name of its own ("main.cpp"), and that is
    // the name the compiler answers with, so the link has to find its way back to the tab.
    await page.selectOption('#language-select', 'cpp');
    await page.waitForSelector('.tab.active:has-text("untitled.cpp")');
    // The stand-in compiler points at line 3, column 5, so give it a file that has one.
    await page.evaluate(() => window.SVS.getEditor().setValue('int main() {\n  int a = 1;\n  int b = 2\n  return 0;\n}\n'));
    pistonMode = 'compile-error';
    await page.click('#btn-run');
    await page.waitForFunction(() => document.querySelector('#output-text .out-link'), null, { timeout: 20000 });
    pistonMode = 'ok';
    await page.click('#output-text .out-link');
    await page.waitForSelector('.tab.active.scratch');
    assert.equal(await page.textContent('#status-cursor'), 'Ln 3, Col 5');
  });

  await step('a Java scratch file is named after its public class', async () => {
    await page.selectOption('#language-select', 'java');
    await page.waitForSelector('.tab.active:has-text("untitled.java")');
    await page.evaluate(() => window.SVS.getEditor().setValue('public class Greeter {\n  public static void main(String[] a) {}\n}\n'));
    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });
    assert.equal(pistonCalls[0].files[0].name, 'Greeter.java');
  });

  await step('a language the service does not offer is reported, not silently run', async () => {
    await page.selectOption('#language-select', 'rust');
    await page.waitForSelector('.tab.active:has-text("untitled.rs")');
    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('does not currently offer'), null, { timeout: 20000 });
    assert.equal(pistonCalls.length, 0, 'nothing should be sent for an unavailable language');
    assert.match(await page.textContent('#language-select'), /Rust \(cannot be run today\)/);
    await page.screenshot({ path: path.join(SHOTS, 'phase3-run.png') });
  });

  await step('when the service cannot be reached, the message says what to do', async () => {
    await page.reload(); // clears the cached runtime list
    await page.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
    await page.waitForSelector('#btn-open-folder:not([disabled])');
    pistonMode = 'offline';
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Could not reach'), null, { timeout: 20000 });
    assert.match(await page.textContent('#output-text'), /internet connection/);
    pistonMode = 'ok';
  });

  await step('the scratch file is given a home on disk, and later saves go straight back to it', async () => {
    // The browser only opens a Save dialog for a real person, so stand in for it. Everything
    // after the dialog — writing, remembering, renaming the tab — is the app's own code.
    await page.evaluate(() => {
      window.__picks = 0;
      window.__written = [];
      window.showSaveFilePicker = async (options) => {
        window.__picks++;
        window.__suggested = options.suggestedName;
        return {
          kind: 'file',
          name: 'greeting.py',
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          createWritable: async () => ({
            write: async (text) => window.__written.push(text),
            close: async () => {},
          }),
        };
      };
    });

    await page.selectOption('#language-select', 'python');
    await page.waitForSelector('.tab.active:has-text("untitled.py")');
    await page.click('.monaco-editor .view-lines');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('print("saved back where it came from")');

    await page.keyboard.press('Control+s');
    await page.waitForSelector('.tab.active:has-text("greeting.py")', { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.__suggested), 'untitled.py', 'the dialog should suggest the scratch name');
    assert.match((await page.evaluate(() => window.__written))[0], /saved back where it came from/);

    // A second save must not ask again: the file already has a home.
    await page.keyboard.type('\n# one more line');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => window.__written.length === 2, null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.__picks), 1, 'the second save must go straight back, without asking');
    assert.match((await page.evaluate(() => window.__written))[1], /one more line/);
    assert.match(await page.textContent('#toasts'), /back where it came from/);
  });

  await step('switching language lets go of a home that belongs to another file type', async () => {
    await page.selectOption('#language-select', 'javascript');
    await page.waitForSelector('.tab.active:has-text("untitled.js")', { timeout: 10000 });
  });

  await step('a remembered folder is offered again on the next visit', async () => {
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('svs-handles', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const tx = request.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({
          name: 'hello',
          handle: { standIn: true },        // a real handle cannot be built by hand
          tabs: [{ path: 'index.html', lineNumber: 1, column: 1 }],
          activePath: 'index.html',
        }, 'last-folder');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      };
    }));

    await page.reload();
    await page.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
    await page.waitForSelector('#reopen-bar:not([hidden])', { timeout: 10000 });
    assert.equal(await page.textContent('#reopen-name'), 'hello');
    assert.match(await page.textContent('#reopen-files'), /1 file open/);
    assert.match(await page.textContent('#menu-reopen-folder'), /Reopen "hello"/);

    // The bar adds a row to the app's grid; the editor must keep the rest of the height.
    const main = await page.locator('#main').boundingBox();
    assert.ok(main.height > 500, `the editor area collapsed to ${main.height}px when the bar appeared`);
    await page.screenshot({ path: path.join(SHOTS, 'reopen-bar.png') });

    await page.click('#btn-reopen-forget');
    await page.waitForSelector('#reopen-bar', { state: 'hidden', timeout: 5000 });
    assert.ok(await page.getAttribute('#menu-reopen-folder', 'hidden') !== null, 'the menu entry should go too');
    const left = await page.evaluate(() => new Promise((resolve) => {
      const request = indexedDB.open('svs-handles', 1);
      request.onsuccess = () => {
        const get = request.result.transaction('kv', 'readonly').objectStore('kv').get('last-folder');
        get.onsuccess = () => resolve(get.result || null);
      };
    }));
    assert.equal(left, null, 'Forget should clear what was remembered');
  });

  await step('reopening a folder puts the tabs back where they were left', async () => {
    await page.evaluate(() => window.SVS.adoptFolder(window.SVS.fs.sampleFolder(), {
      tabs: [
        { path: 'index.html', lineNumber: 1, column: 1 },
        { path: 'css/style.css', lineNumber: 3, column: 5 },
        { path: 'gone.txt', lineNumber: 1, column: 1 },
      ],
      activePath: 'css/style.css',
    }));
    await page.waitForSelector('.tab.active:has-text("style.css")', { timeout: 10000 });
    const names = await page.$$eval('.tab .tab-name', (nodes) => nodes.map((n) => n.textContent));
    assert.deepEqual(names, ['index.html', 'style.css'], 'both files reopen; the missing one is skipped');
    assert.equal(await page.textContent('#status-cursor'), 'Ln 3, Col 5', 'the cursor should be where it was left');
    assert.match(await page.textContent('#toasts'), /1 file is no longer there/);
  });

  /* ---------- Opening a folder from a .zip ---------- */

  // Every zip below is compressed (deflate), the way a zip from Windows, macOS or 7-Zip is:
  // reading those is the whole point, and the app's own writer never produces one.
  const siteZip = makeZip({
    'hello/': '',
    'hello/index.html': '<!doctype html>\n<title>Zipped</title>\n<h1>From a zip</h1>\n',
    'hello/css/style.css': 'body { color: #0f0; }\n',
    'hello/img/dot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]),
    'hello/img/pixel.png': makePng(3, 2),
    'hello/empty/': '',
    '__MACOSX/hello/._index.html': 'junk macOS leaves in every zip it makes',
  });

  // Waiting on a tab or a file path is not enough between projects: index.html is open in most
  // of them. The Explorer header is rebuilt from scratch for each folder, so it is the signal.
  const waitForProject = (name) => page.waitForFunction(
    (expected) => document.querySelector('.tree-header-name')?.textContent === expected,
    name,
    { timeout: 10000 },
  );

  await step('a zip opens like a folder, with the single folder inside it peeled off', async () => {
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return window.SVS.openZipFile(bytes, { fileName: 'hello.zip' });
    }, toBase64(siteZip));

    await waitForProject('hello'); // the folder inside the zip becomes the root
    await page.waitForSelector('.tree-row[data-path="index.html"]', { timeout: 10000 });
    // The macOS junk folder is not something anyone opened a zip to see.
    assert.equal(await page.locator('.tree-row[data-path="__MACOSX"]').count(), 0, '__MACOSX should be left out');
    await page.waitForSelector('.tab.active:has-text("index.html")', { timeout: 10000 });
    assert.match(
      await page.evaluate(() => window.SVS.getEditor().getModel().getValue()),
      /From a zip/,
      'a compressed entry must come out as its original text',
    );
    assert.match(await page.textContent('#status-folder'), /hello \(from a zip\)/);
    assert.match(await page.getAttribute('#status-folder', 'title'), /Opened from hello\.zip/);
  });

  await step('a binary file inside a zip survives being unpacked', async () => {
    const bytes = await page.evaluate(async () => [...new Uint8Array(await window.SVS.fs.readBinary('img/dot.png'))]);
    assert.deepEqual(bytes, [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254], 'the PNG bytes must be untouched');
  });

  await step('an image opens in an image tab that says how big it is', async () => {
    await page.click('.tree-row[data-path="img"]');
    await page.click('.tree-row[data-path="img/pixel.png"]');
    await page.waitForSelector('.image-view .image-canvas');
    await page.waitForFunction(
      () => /3 × 2/.test(document.querySelector('.image-meta')?.textContent || ''),
      null, { timeout: 10000 },
    );
    const meta = await page.textContent('.image-meta');
    assert.match(meta, /3 × 2/, 'the real pixel size should be read from the image');
    assert.match(meta, /PNG/);
    assert.equal(await exists('.image-view.fit'), true, 'it should start scaled to fit');
    assert.equal(await page.textContent('.image-zoom'), 'Full size');

    await page.click('.image-zoom');
    assert.equal(await exists('.image-view.fit'), false, 'the button should switch to full size');
    assert.equal(await page.textContent('.image-zoom'), 'Fit to tab');
    // Switching away and back must not leave two pictures behind or lose the choice.
    await page.click('.tab:has-text("index.html")');
    await page.click('.tab:has-text("pixel.png")');
    await page.waitForSelector('.image-view .image-canvas');
    assert.equal(await page.locator('.image-canvas').count(), 1);
    assert.equal(await exists('.image-view.fit'), false, 'it should still be at full size');
  });

  await step('a file that only pretends to be an image says so', async () => {
    await page.click('.tree-row[data-path="img/dot.png"]');
    await page.waitForFunction(
      () => document.getElementById('editor-placeholder').textContent.includes('could not be displayed'),
      null, { timeout: 10000 },
    );
    await page.click('.tab:has-text("index.html")');
  });

  await step('a font or archive is not claimed to be editable text', async () => {
    await page.evaluate(async () => {
      const { fs } = window.SVS;
      await fs.createFile('', 'font.woff2');
      await fs.writeText('font.woff2', 'not really a font, but the extension is what counts');
    });
    await page.hover('#view-explorer');
    await page.click('[data-action="refresh"]');
    // Straight from the image tab, whose <img> is being let go of as this one is drawn.
    await page.click('.tab:has-text("pixel.png")');
    await page.waitForSelector('.image-view .image-canvas');
    await page.click('.tree-row[data-path="font.woff2"]');
    await page.waitForFunction(
      () => document.getElementById('editor-placeholder').textContent.includes('binary file'),
      null, { timeout: 10000 },
    );
    const shown = await page.textContent('#editor-placeholder');
    assert.match(shown, /\d+ B|KB/, 'it should say how big the file is');
    assert.doesNotMatch(shown, /could not be displayed/, 'the image tab must not leave its message behind');
    await page.click('.tab:has-text("index.html")');
  });

  await step('editing a file from a zip says the edit is not back in the zip yet', async () => {
    await page.click('.monaco-editor .view-lines');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n<p>edited in the test</p>');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.getElementById('status-folder').textContent.includes('not on your disk yet'));
    assert.match(await page.textContent('#toasts'), /Save Folder downloads hello\.zip/);
  });

  await step('Save Folder packs a zip project back into a zip of the same shape', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#status-folder'),
    ]);
    // The name of the zip it came from, not the name of the folder inside it.
    assert.equal(download.suggestedFilename(), 'hello.zip');

    const entries = readZip(readFileSync(await download.path()));
    assert.ok(entries.has('hello/index.html'), `the wrapper folder must come back, got ${[...entries.keys()]}`);
    assert.ok(entries.has('hello/empty/'), 'an empty folder in the zip should still be there');
    assert.match(entries.get('hello/index.html').toString('utf8'), /edited in the test/);
    await page.waitForFunction(() => !document.getElementById('status-folder').textContent.includes('not on your disk'));
  });

  await step('a zip whose files sit at its own root is written back flat, not in a new folder', async () => {
    const flat = makeZip({ 'index.html': '<h1>Flat</h1>', 'css/style.css': 'body {}' });
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return window.SVS.openZipFile(bytes, { fileName: 'flat.zip' });
    }, toBase64(flat));
    await waitForProject('flat'); // with nothing to peel, the zip itself names the root
    await page.waitForSelector('.tree-row[data-path="index.html"]', { timeout: 10000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#status-folder'),
    ]);
    const entries = readZip(readFileSync(await download.path()));
    assert.deepEqual(
      [...entries.keys()].sort(),
      ['css/', 'css/style.css', 'index.html'],
      'a flat zip must stay flat, or every round trip would bury it one folder deeper',
    );
  });

  await step('Open Zip File… opens what the picker hands back, and Save Folder writes into it', async () => {
    await page.evaluate((b64) => {
      window.__zipWrites = [];
      window.showOpenFilePicker = async () => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return [{
          kind: 'file',
          name: 'picked.zip',
          getFile: async () => new File([bytes], 'picked.zip', { type: 'application/zip' }),
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          createWritable: async () => ({
            write: async (blob) => window.__zipWrites.push(new Uint8Array(await blob.arrayBuffer())),
            close: async () => {},
          }),
        }];
      };
    }, toBase64(siteZip));

    await page.click('#btn-open-menu');
    await page.click('[data-command="open-zip"]');
    await page.waitForFunction(
      () => document.getElementById('toasts').textContent.includes('Opened "picked.zip"'),
      null,
      { timeout: 10000 },
    );
    await waitForProject('hello');
    assert.match(await page.textContent('#toasts'), /packs them back into that same zip/);

    // With a handle to write through, Save Folder overwrites the zip instead of downloading it.
    await page.click('#status-folder');
    await page.waitForFunction(() => window.__zipWrites.length === 1, null, { timeout: 10000 });
    const written = Buffer.from(await page.evaluate(() => [...window.__zipWrites[0]]));
    const entries = readZip(written);
    assert.ok(entries.has('hello/index.html'), `the written zip should hold the project, got ${[...entries.keys()]}`);
    assert.match(await page.textContent('#toasts'), /back where it came from/);
  });

  await step('a zip inside a folder opens as a project of its own', async () => {
    const inner = makeZip({ 'bits/page.html': '<h1>Inner</h1>' });
    const outer = makeZip({
      'proj/index.html': '<h1>Outer</h1>',
      'proj/inner.zip': inner,
    });
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return window.SVS.openZipFile(bytes, { fileName: 'outer.zip' });
    }, toBase64(outer));
    await page.waitForSelector('.tree-row[data-path="inner.zip"]', { timeout: 10000 });

    // Clicking it asks first, because the folder you are in is about to be replaced.
    await page.click('.tree-row[data-path="inner.zip"]');
    await page.waitForSelector('dialog[open]');
    assert.match(await page.textContent('dialog[open] .dialog-title'), /Open "inner\.zip" as a project\?/);
    await page.click('dialog[open] .dialog-confirm');

    await waitForProject('bits');
    await page.waitForSelector('.tree-row[data-path="page.html"]');
  });

  await step('a damaged zip is refused, and the folder you had open is left alone', async () => {
    await page.evaluate(() => {
      const junk = new TextEncoder().encode('this is not a zip, it is just some text');
      return window.SVS.openZipFile(junk, { fileName: 'broken.zip' });
    });
    await page.waitForFunction(() => document.getElementById('toasts').textContent.includes('does not look like a zip'));
    assert.equal(await page.textContent('.tree-header-name'), 'bits', 'the open folder must survive a zip that cannot be read');
  });

  // The outside-change watcher only runs for a real folder on the disk, and no test can click
  // the browser's folder picker. So the app is handed a folder that behaves like one — it
  // answers the same calls, and the test decides what its files say and when they changed.
  await step('a file changed outside the editor updates a tab you have not touched', async () => {
    await page.evaluate(() => {
      const files = new Map([['main.js', 'console.log("from the disk")\n']]);
      const times = new Map([['main.js', 1000]]);
      window.__disk = { files, times };
      const list = () => [...files.keys()].map((path) => ({ name: path, path, kind: 'file' }));
      return window.SVS.adoptFolder({
        kind: 'native',            // the watcher only follows a folder that can change behind us
        name: 'watched',
        readOnly: false,
        sample: false,
        handle: null,
        async tree() { return { name: 'watched', path: '', kind: 'dir', children: list() }; },
        async readText(path) { return files.get(path); },
        async readBinary(path) { return new TextEncoder().encode(files.get(path)).buffer; },
        async stat(path) { return { size: files.get(path).length, lastModified: times.get(path) }; },
        async writeText(path, text) { files.set(path, text); times.set(path, (times.get(path) || 0) + 1000); },
        async createFile() { throw new Error('not needed'); },
        async createDir() { throw new Error('not needed'); },
        async exists(path) { return files.has(path); },
        async remove(path) {
          // The test can make a delete fail, the way a locked or no-longer-permitted file does.
          if (window.__disk.failRemove) throw new Error('the file is locked');
          files.delete(path);
        },
        async rename() { throw new Error('not needed'); },
        async countFiles() { return 0; },
      });
    });
    await waitForProject('watched');
    await page.click('.tree-row[data-path="main.js"]');
    await page.waitForSelector('.tab.active:has-text("main.js")');

    await page.evaluate(() => {
      window.__disk.files.set('main.js', 'console.log("changed by something else")\n');
      window.__disk.times.set('main.js', 9000);
      return window.SVS.checkNow();
    });
    await page.waitForFunction(
      () => window.SVS.getEditor().getValue().includes('changed by something else'),
      null, { timeout: 10000 },
    );
    assert.equal(await exists('.tab.active.dirty'), false, 'a tab you never edited stays clean');
    await page.waitForSelector('.toast:has-text("changed outside the editor")');
  });

  await step('a file changed outside the editor asks before touching your unsaved work', async () => {
    await page.click('.monaco-editor .view-lines');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n// my own unsaved line');
    await page.waitForSelector('.tab.active.dirty');

    await page.evaluate(() => {
      window.__disk.files.set('main.js', 'console.log("their version")\n');
      window.__disk.times.set('main.js', 12000);
      return window.SVS.checkNow();
    });
    await page.waitForSelector('.toast.warning:has-text("unsaved changes") .toast-actions .btn');
    assert.match(await editorValue(), /my own unsaved line/, 'nothing may be replaced before you answer');

    await page.click('.toast .toast-actions .btn:has-text("Keep mine")');
    await page.waitForSelector('.toast:has-text("Kept your version")');
    assert.match(await editorValue(), /my own unsaved line/);
    assert.equal(await exists('.tab.active.dirty'), true, 'your version is still unsaved');
  });

  await step('choosing "Load theirs" takes the version from the disk', async () => {
    await page.evaluate(() => {
      window.__disk.files.set('main.js', 'console.log("the newest from the disk")\n');
      window.__disk.times.set('main.js', 15000);
      return window.SVS.checkNow();
    });
    await page.waitForSelector('.toast .toast-actions .btn:has-text("Load theirs")');
    await page.click('.toast .toast-actions .btn:has-text("Load theirs")');
    await page.waitForFunction(
      () => window.SVS.getEditor().getValue().includes('the newest from the disk'),
      null, { timeout: 10000 },
    );
    assert.doesNotMatch(await editorValue(), /my own unsaved line/);
    assert.equal(await exists('.tab.active.dirty'), false, 'taking their version leaves nothing unsaved');
  });

  await step('our own save is not reported as an outside change', async () => {
    await page.click('.monaco-editor .view-lines');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n// saved by me');
    await page.keyboard.press('Control+s');
    await page.waitForSelector('.tab.active:not(.dirty)');
    // Ctrl+S moves the file's modification time, which is exactly what the watcher looks at.
    await page.evaluate(() => window.SVS.checkNow());
    await sleep(200);
    assert.match(await editorValue(), /saved by me/, 'the save must not be undone by a reload');
    const toasts = await page.$$eval('.toast .toast-text', (all) => all.map((t) => t.textContent));
    assert.ok(
      !toasts.some((text) => text.includes('changed outside the editor')),
      `no outside-change notice should appear, got ${JSON.stringify(toasts)}`,
    );
  });

  await step('a question closed unanswered is not repeated, but the next change still asks', async () => {
    await page.click('.monaco-editor .view-lines');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n// unsaved again');
    await page.waitForSelector('.tab.active.dirty');

    await page.evaluate(() => {
      window.__disk.files.set('main.js', 'console.log("theirs again")\n');
      window.__disk.times.set('main.js', 20000);
      return window.SVS.checkNow();
    });
    await page.waitForSelector('.toast.warning:has-text("unsaved changes")');
    await page.click('.toast.warning:has-text("unsaved changes") .toast-close');

    // The same change must not come back every three seconds…
    await page.evaluate(() => window.SVS.checkNow());
    await sleep(200);
    assert.equal(await page.locator('.toast.warning:has-text("unsaved changes")').count(), 0);
    assert.match(await editorValue(), /unsaved again/, 'and nothing of ours may be replaced');

    // …but a further change on the disk is a new question, not silence.
    await page.evaluate(() => {
      window.__disk.files.set('main.js', 'console.log("newer still")\n');
      window.__disk.times.set('main.js', 25000);
      return window.SVS.checkNow();
    });
    await page.waitForSelector('.toast.warning:has-text("unsaved changes")');
  });

  await step('a delete that fails keeps the file and its tab', async () => {
    await showExplorer();
    await page.evaluate(() => { window.__disk.failRemove = true; });
    await page.click('.tree-row[data-path="main.js"]', { button: 'right' });
    await page.click('.context-menu .context-item:has-text("Delete")');
    await page.waitForSelector('dialog.dialog[open]');
    await page.click('.dialog-confirm');

    await page.waitForSelector('.toast.error:has-text("Unable to delete")');
    await page.waitForSelector('.tree-row[data-path="main.js"]');
    assert.equal(await page.locator('.tab:has-text("main.js")').count(), 1, 'the tab must survive a failed delete');
    assert.match(await editorValue(), /unsaved again/, 'and so must the unsaved changes in it');
    await page.evaluate(() => { window.__disk.failRemove = false; });
  });

  await step('no JavaScript errors were thrown by the page', async () => {
    const report = pageErrors.map((e) => `[during "${e.step}"] ${e.message}\n${e.stack}`).join('\n\n');
    assert.equal(pageErrors.length, 0, `Page errors:\n${report}`);
  });
} catch (err) {
  console.error('Test run aborted:', err);
  results.push({ name: 'run', ok: false, err });
} finally {
  await browser?.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length ? 1 : 0);

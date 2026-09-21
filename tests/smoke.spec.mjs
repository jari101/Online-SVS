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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.PORT || 8123);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(here, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const localMonaco = path.join(here, 'node_modules', 'monaco-editor', 'min', 'vs', 'loader.js');
const localPyodide = path.join(here, 'node_modules', 'pyodide', 'pyodide.mjs');
if (!existsSync(localMonaco) || !existsSync(localPyodide)) {
  console.error('Run `npm install` inside tests/ first (it downloads local copies of Monaco and Pyodide).');
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
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // A stand-in for a Piston code runner — the kind you set up in Settings for the languages
  // a browser cannot compile. The sandbox has no internet access, and even with it we would
  // not want the tests hitting a real server. `pistonMode` lets each step decide what it
  // answers; `pistonCalls` records what we sent it, so a step can also prove that a run which
  // should have stayed in the browser sent nothing at all.
  const pistonCalls = [];
  let pistonMode = 'ok';
  let pistonDelay = 0;
  const RUNTIMES = [
    { language: 'python', version: '2.7.18', aliases: [] },
    { language: 'python', version: '3.12.0', aliases: ['py', 'python3'] },
    { language: 'c++', version: '10.2.0', aliases: ['cpp', 'g++'] },
    { language: 'javascript', version: '20.11.1', aliases: ['node', 'js'] },
    { language: 'java', version: '15.0.2', aliases: [] },
    { language: 'java', version: '19.0.2', aliases: [] },
  ];
  await context.route('**/api/v2/piston/runtimes', (route) => {
    if (pistonMode === 'offline') return route.abort('failed');
    return route.fulfill({ json: RUNTIMES });
  });
  await context.route('**/api/v2/piston/execute', async (route) => {
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
    // There is no code runner built into the app any more, so give the test one to talk to.
    // The routes above answer it; nothing leaves the sandbox.
    window.SVS_PISTON_URL = 'https://runner.test/api/v2/piston';
    // The real Pyodide, from the local npm copy rather than the CDN, so the test runs real
    // CPython without needing internet. Production loads the same files from CONFIG.pyodideBase.
    window.SVS_PYODIDE_BASE = `${location.origin}/tests/node_modules/pyodide/`;
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

  await step('a program still runs in the browser while the live server is on', async () => {
    // The Service Worker answers only addresses under live/, so the Web Worker that runs your
    // code must still load normally. Worth pinning down: if it ever did intercept them, Run
    // would break only while Go Live was on.
    await page.click('.tree-row[data-path="js/app.js"]');
    await page.waitForSelector('.tab.active:has-text("app.js")');
    await page.evaluate(() => window.SVS.getEditor().setValue('console.log("live and running");\n'));
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });
    assert.match(await page.textContent('#output-text'), /live and running/);
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

  await step('JavaScript runs inside the browser, with the helpers beside it', async () => {
    // A helper for the companion rule to pick up, plus two files that must never be uploaded.
    await page.evaluate(async () => {
      const { fs } = window.SVS;
      await fs.createFile('js', 'helper.js');
      await fs.writeText('js/helper.js', 'export const WHO = "helper.js";\n');
      await fs.createFile('js', 'config.json');
      await fs.writeText('js/config.json', '{"apiKey":"super-secret-value"}');
    });
    await page.hover('#view-explorer'); // the tree's action buttons appear on hover
    await page.click('[data-action="refresh"]');
    await page.waitForSelector('.tree-row[data-path="js/helper.js"]');

    await page.click('.tree-row[data-path="js/app.js"]');
    await page.waitForSelector('.tab.active:has-text("app.js")');
    await page.evaluate(() => window.SVS.getEditor().setValue(
      'import { WHO } from "./helper.js";\n'
      + 'console.log("hello from", WHO);\n'
      + 'console.log({ a: 1, b: [2, 3] });\n'
      + 'setTimeout(() => console.log("and later"), 20);\n',
    ));

    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForSelector('#panel-output:not([hidden])');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });

    const output = await page.textContent('#output-text');
    assert.equal(pistonCalls.length, 0, 'a browser run must not send anything to a server');
    assert.match(output, /Running app\.js with JavaScript/);
    assert.match(output, /Also using from the same folder: helper\.js/);
    assert.match(output, /hello from helper\.js/);
    assert.match(output, /\{ a: 1, b: \[ 2, 3 \] \}/, 'objects should be shown, not printed as [object Object]');
    assert.match(output, /and later/, 'a setTimeout must still get to print before the run ends');
    assert.match(output, /Exit code 0/);
    assert.equal(await page.textContent('#output-where'), 'in your browser');
    assert.equal(await exists('#output-meta.remote'), false, 'a browser run must not be marked as sent away');
  });

  await step('an error in the browser reports the file name, not a blob address', async () => {
    await page.evaluate(() => window.SVS.getEditor().setValue('console.log("before");\nboom();\n'));
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });
    const output = await page.textContent('#output-text');
    assert.match(output, /before/);
    assert.match(output, /boom is not defined/);
    assert.doesNotMatch(output, /blob:/, 'a blob: address means nothing to the person reading it');
    assert.match(output, /Exit code 1/);
  });

  await step('the Input tab is handed to a browser run as stdin', async () => {
    await page.evaluate(() => window.SVS.getEditor().setValue(
      'console.log("first:", readline());\nconsole.log("second:", readline());\n',
    ));
    await page.click('.panel-tab[data-tab="input"]');
    await page.fill('#stdin-input', 'line one\nline two');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });
    const output = await page.textContent('#output-text');
    assert.match(output, /first: line one/);
    assert.match(output, /second: line two/);
    // Run switches the panel to Output, so come back to Input before clearing it.
    await page.click('.panel-tab[data-tab="input"]');
    await page.fill('#stdin-input', '');
    await page.click('.panel-tab[data-tab="output"]');
  });

  await step('TypeScript is compiled by the editor itself and then run in the browser', async () => {
    await page.evaluate(async () => {
      const { fs } = window.SVS;
      await fs.createFile('', 'greet.ts');
      await fs.writeText('greet.ts', 'const who: string = "TypeScript";\nconsole.log(`hello from ${who}`);\n');
    });
    await page.hover('#view-explorer');
    await page.click('[data-action="refresh"]');
    await page.waitForSelector('.tree-row[data-path="greet.ts"]');
    await page.click('.tree-row[data-path="greet.ts"]');
    await page.waitForSelector('.tab.active:has-text("greet.ts")');

    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 30000 });
    const output = await page.textContent('#output-text');
    assert.equal(pistonCalls.length, 0, 'TypeScript must not need a server either');
    assert.match(output, /hello from TypeScript/);
    assert.match(output, /Exit code 0/);
  });

  await step('Python runs in the browser and imports the file beside it', async () => {
    await page.evaluate(async () => {
      const { fs } = window.SVS;
      await fs.createFile('', 'tool.py');
      await fs.writeText('tool.py', 'NAME = "tool.py"\n');
      await fs.createFile('', 'start.py');
      await fs.writeText('start.py', 'import math\nfrom tool import NAME\nprint(NAME, math.sqrt(16))\nanswer = input()\nprint(answer)\n');
    });
    await page.hover('#view-explorer');
    await page.click('[data-action="refresh"]');
    await page.waitForSelector('.tree-row[data-path="start.py"]');
    await page.click('.tree-row[data-path="start.py"]');
    await page.waitForSelector('.tab.active:has-text("start.py")');
    await page.click('.panel-tab[data-tab="input"]');
    await page.fill('#stdin-input', 'typed by the test');

    pistonCalls.length = 0;
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 120000 });
    const output = await page.textContent('#output-text');
    assert.equal(pistonCalls.length, 0, 'Python must not need a server');
    assert.match(output, /Running start\.py with Python 3\.\d+/);
    assert.match(output, /tool\.py 4\.0/, 'the companion file and the standard library must both be there');
    assert.match(output, /typed by the test/, 'input() must read the Input tab');
    assert.match(output, /Exit code 0/);
    assert.equal(await page.textContent('#output-where'), 'in your browser');
    await page.click('.panel-tab[data-tab="input"]');
    await page.fill('#stdin-input', '');
    await page.click('.panel-tab[data-tab="output"]');
  });

  await step('a Python traceback points at your line, without the interpreter plumbing', async () => {
    await page.evaluate(() => window.SVS.getEditor().setValue('print("before")\nmissing_name\n'));
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 60000 });
    const output = await page.textContent('#output-text');
    assert.match(output, /before/);
    assert.match(output, /NameError: name 'missing_name' is not defined/);
    assert.match(output, /File "start\.py", line 2/, 'the traceback should name your file and line');
    assert.doesNotMatch(output, /_pyodide/, 'Pyodide\'s own frames say nothing about your program');
    assert.doesNotMatch(output, /eval_code_async/);
    assert.match(output, /Exit code 1/);
  });

  await step('a print() with no newline is not held back into the next run', async () => {
    // Python buffers stdout. Without a flush at the end of a run, "Enter name: " would sit in
    // the buffer and appear at the top of whatever you ran next.
    await page.evaluate(() => window.SVS.getEditor().setValue('print("Enter name: ", end="")\n'));
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 60000 });
    assert.match(await page.textContent('#output-text'), /Enter name: /);

    await page.evaluate(() => window.SVS.getEditor().setValue('print("a clean start")\n'));
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 60000 });
    const next = await page.textContent('#output-text');
    assert.match(next, /a clean start/);
    assert.doesNotMatch(next, /Enter name/, 'last run\'s output must not turn up in this one');
  });

  await step('sys.exit(3) is an exit code, not a crash', async () => {
    await page.evaluate(() => window.SVS.getEditor().setValue('import sys\nprint("leaving")\nsys.exit(3)\n'));
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 60000 });
    const output = await page.textContent('#output-text');
    assert.match(output, /leaving/);
    assert.match(output, /Exit code 3/);
    assert.doesNotMatch(output, /Traceback/, 'sys.exit is not an error');
  });

  await step('variables do not survive into the next Python run', async () => {
    await page.evaluate(() => window.SVS.getEditor().setValue('leftover = 42\nprint("set it")\n'));
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 60000 });
    await page.evaluate(() => window.SVS.getEditor().setValue('print(leftover)\n'));
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 60000 });
    assert.match(await page.textContent('#output-text'), /NameError/);
  });

  await step('editing a Python file beside yours takes effect on the next run', async () => {
    await page.click('.tree-row[data-path="start.py"]');
    await page.waitForSelector('.tab.active:has-text("start.py")');
    await page.evaluate(() => window.SVS.getEditor().setValue('from tool import NAME\nprint(NAME)\n'));
    await page.evaluate(() => window.SVS.fs.writeText('tool.py', 'NAME = "edited tool.py"\n'));
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 60000 });
    // Python caches imports, so a stale sys.modules entry would still show the old text.
    assert.match(await page.textContent('#output-text'), /edited tool\.py/);
  });

  await step('Run sends a C++ file and its companions to the runner, but not data or secrets', async () => {
    await page.evaluate(async () => {
      const { fs } = window.SVS;
      await fs.createFile('', 'sums.cpp');
      await fs.writeText('sums.cpp', '#include "sums.h"\nint main() { return total(2); }\n');
      await fs.createFile('', 'sums.h');
      await fs.writeText('sums.h', 'int total(int n);\n');
      await fs.createFile('', 'secret_token.cpp');
      await fs.writeText('secret_token.cpp', 'const char *TOKEN = "super-secret-value";\n');
    });
    await page.hover('#view-explorer');
    await page.click('[data-action="refresh"]');
    await page.waitForSelector('.tree-row[data-path="sums.cpp"]');
    await page.click('.tree-row[data-path="sums.cpp"]');
    await page.waitForSelector('.tab.active:has-text("sums.cpp")');

    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });

    assert.equal(pistonCalls.length, 1);
    const sent = pistonCalls[0];
    assert.equal(sent.language, 'c++');
    assert.equal(sent.version, '10.2.0');
    assert.equal(sent.files[0].name, 'sums.cpp', 'the file being run must come first');
    const names = sent.files.map((f) => f.name);
    assert.ok(names.includes('sums.h'), 'the header must be sent');
    assert.ok(!names.includes('secret_token.cpp'), 'a file named like a secret must not be sent');
    const body = JSON.stringify(sent);
    assert.ok(!body.includes('super-secret-value'), 'no secret content may reach the server');
    const output = await page.textContent('#output-text');
    assert.match(output, /Running sums\.cpp with C\+\+ 10\.2\.0/);
    assert.match(output, /Also sending from the same folder: sums\.h/);
    assert.match(output, /name suggests it holds secrets/);
    assert.equal(await page.textContent('#output-where'), 'sent to runner.test');
    assert.equal(await exists('#output-meta.remote'), true, 'a run that left the browser must say so');
  });

  await step('the Input tab is handed to the runner as stdin', async () => {
    await page.click('.panel-tab[data-tab="input"]');
    await page.fill('#stdin-input', 'line one\nline two');
    pistonCalls.length = 0;
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });
    assert.equal(pistonCalls[0].stdin, 'line one\nline two');
    assert.match(await page.textContent('#output-text'), /stdin was: line one/);
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

  await step('being rate limited explains itself in plain words', async () => {
    pistonMode = 'ratelimit';
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('limiting how often'), null, { timeout: 20000 });
    pistonMode = 'ok';
  });

  await step('a program stopped by the runner says so', async () => {
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

  await step('pressing Run again while it is running stops it, without a second request', async () => {
    pistonDelay = 4000;
    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForSelector('#btn-run.running');
    assert.equal(await page.textContent('.btn-run-label'), 'Running…');
    await page.click('#btn-run');           // second press = stop
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Stopped'), null, { timeout: 20000 });
    await page.waitForSelector('#btn-run:not(.running)');
    assert.equal(pistonCalls.length, 1, 'a second press must not start another run');
    pistonDelay = 0;
  });

  await step('Stop really ends an endless loop running in the browser', async () => {
    await page.evaluate(async () => {
      const { fs } = window.SVS;
      await fs.createFile('', 'forever.js');
      await fs.writeText('forever.js', 'console.log("starting");\nwhile (true) { /* never ends */ }\n');
    });
    await page.hover('#view-explorer');
    await page.click('[data-action="refresh"]');
    await page.waitForSelector('.tree-row[data-path="forever.js"]');
    await page.click('.tree-row[data-path="forever.js"]');
    await page.waitForSelector('.tab.active:has-text("forever.js")');

    await page.click('#btn-run');
    await page.waitForSelector('#btn-run.running');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('starting'), null, { timeout: 20000 });
    await page.click('#btn-run');           // a server run could only stop waiting; this stops the program
    await page.waitForSelector('#btn-run:not(.running)', { timeout: 20000 });
    assert.match(await page.textContent('#output-text'), /Stopped/);
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

  await step('the scratch Python file runs in the browser, sending nothing anywhere', async () => {
    await page.evaluate(() => window.SVS.getEditor().setValue('print("from the scratch file")\n'));
    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 30000 });
    assert.equal(pistonCalls.length, 0, 'Python must never reach a server');
    const output = await page.textContent('#output-text');
    assert.match(output, /Running main\.py with Python 3\.\d+/);
    assert.match(output, /from the scratch file/);
    assert.equal(await page.textContent('#output-where'), 'in your browser');
  });

  await step('a Java scratch file is named after its public class, on the newest version', async () => {
    await page.selectOption('#language-select', 'java');
    await page.waitForSelector('.tab.active:has-text("untitled.java")');
    await page.evaluate(() => window.SVS.getEditor().setValue('public class Greeter {\n  public static void main(String[] a) {}\n}\n'));
    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 20000 });
    assert.equal(pistonCalls[0].files[0].name, 'Greeter.java');
    assert.equal(pistonCalls[0].version, '19.0.2', 'the newest listed version should win over 15.0.2');
  });

  await step('a language the runner does not offer is reported, not silently run', async () => {
    await page.selectOption('#language-select', 'rust');
    await page.waitForSelector('.tab.active:has-text("untitled.rs")');
    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('does not offer'), null, { timeout: 20000 });
    assert.equal(pistonCalls.length, 0, 'nothing should be sent for an unavailable language');
    assert.match(await page.textContent('#language-select'), /Rust — your runner does not have it/);
    assert.match(await page.textContent('#language-select'), /Python — runs in your browser/);
    await page.screenshot({ path: path.join(SHOTS, 'phase3-run.png') });
  });

  await step('when the runner cannot be reached, the message says what to do', async () => {
    await page.reload(); // clears the cached runtime list
    await page.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
    await page.waitForSelector('#btn-open-folder:not([disabled])');
    await page.selectOption('#language-select', 'cpp');
    await page.waitForSelector('.tab.active:has-text("untitled.cpp")');
    pistonMode = 'offline';
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Could not reach'), null, { timeout: 20000 });
    const output = await page.textContent('#output-text');
    assert.match(output, /Could not reach your code runner/);
    assert.match(output, /CORS/);
    assert.equal(await exists('#view-settings:not([hidden])'), true, 'a runner problem should take you to Settings');
    pistonMode = 'ok';
  });

  await step('with no code runner set up, C++ explains itself and opens Settings', async () => {
    await page.click('#btn-settings');
    await page.fill('#setting-runner-url', '');
    await page.dispatchEvent('#setting-runner-url', 'change');
    await page.click('.activity[data-view="explorer"]');
    await page.waitForSelector('#view-settings', { state: 'hidden' });

    // The status bar carries the standing reminder, whether or not Settings is open.
    await page.waitForSelector('#status-runner:not([hidden])');
    assert.match(await page.textContent('#status-runner'), /C\+\+ needs a code runner/);

    pistonCalls.length = 0;
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('cannot run inside your browser'), null, { timeout: 20000 });
    const output = await page.textContent('#output-text');
    assert.equal(pistonCalls.length, 0, 'with no address there is nowhere to send it');
    assert.match(output, /C\+\+ cannot run inside your browser/);
    assert.match(output, /Switch to Python, JavaScript and TypeScript/);
    assert.match(output, /Settings/);
    assert.equal(await exists('#view-settings:not([hidden])'), true, 'Run must take you to the field that fixes it');
    assert.match(await page.textContent('#language-select'), /C\+\+ — needs a code runner/);
  });

  await step('Python still runs with no code runner at all', async () => {
    await page.selectOption('#language-select', 'python');
    await page.waitForSelector('.tab.active:has-text("untitled.py")');
    await page.evaluate(() => window.SVS.getEditor().setValue('print("no server needed")\n'));
    await page.click('#btn-run');
    await page.waitForFunction(() => document.getElementById('output-text').textContent.includes('Exit code'), null, { timeout: 30000 });
    assert.match(await page.textContent('#output-text'), /no server needed/);
    assert.equal(await exists('#status-runner:not([hidden])'), false, 'a browser language needs no reminder');
  });

  await step('when Python cannot be downloaded, the message says what to change', async () => {
    // In its own page, so the interpreter the main page already booted is not disturbed.
    const probe = await context.newPage();
    await probe.addInitScript((base) => {
      window.SVS_MONACO_BASE = base;
      window.SVS_PYODIDE_BASE = `${location.origin}/nowhere-at-all/`;
      window.SVS_DEBUG = true;
    }, `${BASE}/tests/node_modules/monaco-editor/min`);
    await probe.goto(`${BASE}/`);
    await probe.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
    await probe.waitForSelector('#btn-open-folder:not([disabled])');
    await probe.selectOption('#language-select', 'python');
    await probe.waitForSelector('.tab.active:has-text("untitled.py")');
    await probe.click('#btn-run');
    await probe.waitForFunction(() => document.getElementById('output-text').textContent.includes('config.js'), null, { timeout: 30000 });
    const output = await probe.textContent('#output-text');
    assert.match(output, /Python could not be started from/);
    assert.match(output, /Check your internet connection/);
    assert.match(output, /pyodideVersion in js\/config\.js/, 'the one thing to change should be named');
    await probe.close();
  });

  await step('picking a language that needs a runner opens Settings, but only the first time', async () => {
    await page.click('.activity[data-view="explorer"]');
    await page.waitForSelector('#view-settings', { state: 'hidden' });

    await page.selectOption('#language-select', 'java');
    await page.waitForSelector('#view-settings:not([hidden])');   // the first time, it opens itself
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      'setting-runner-url',
      'the cursor should land in the field that fixes it',
    );

    await page.click('.activity[data-view="explorer"]');
    await page.waitForSelector('#view-settings', { state: 'hidden' });
    await page.selectOption('#language-select', 'go');
    await sleep(300);
    assert.equal(await exists('#view-settings:not([hidden])'), false, 'after that it should not keep interrupting');
    assert.match(await page.textContent('#status-runner'), /Go needs a code runner/);
  });

  await step('Settings tests a code runner address and remembers it', async () => {
    await page.click('#btn-settings');
    await page.fill('#setting-runner-url', 'https://runner.test/api/v2/piston/');
    await page.click('#btn-test-runner');
    await page.waitForFunction(() => document.getElementById('runner-status').textContent.includes('Connected'), null, { timeout: 20000 });
    assert.match(await page.textContent('#runner-status'), /can run 4 languages/);

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('svs.settings')));
    assert.equal(saved.runnerUrl, 'https://runner.test/api/v2/piston', 'the trailing slash should be trimmed off');

    // An address with no scheme is explained rather than quietly thrown away.
    await page.fill('#setting-runner-url', 'runner.test/api/v2/piston');
    await page.dispatchEvent('#setting-runner-url', 'change');
    await page.waitForFunction(() => document.getElementById('runner-status').textContent.includes('http://'), null, { timeout: 20000 });
    assert.equal(
      await page.inputValue('#setting-runner-url'),
      'runner.test/api/v2/piston',
      'what you typed must still be there to correct',
    );
    assert.equal(
      await page.evaluate(() => JSON.parse(localStorage.getItem('svs.settings')).runnerUrl),
      'https://runner.test/api/v2/piston',
      'an address that was never accepted must not replace the one that works',
    );

    await page.fill('#setting-runner-url', 'https://runner.test/api/v2/piston');
    await page.dispatchEvent('#setting-runner-url', 'change');
    await page.click('.activity[data-view="explorer"]');
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

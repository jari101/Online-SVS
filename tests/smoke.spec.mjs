// tests/smoke.spec.mjs — end-to-end smoke test.
// Starts a static server for the repository, opens the app in headless Chromium and clicks
// through the main features, including the live server. Monaco is served from the local npm
// copy so the test also works without internet access.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

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

/* ---------- the test ---------- */
let browser;
const pageErrors = [];
try {
  await waitForServer();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

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
    pistonCalls.push(JSON.parse(route.request().postData()));
    if (pistonDelay) await new Promise((r) => setTimeout(r, pistonDelay));
    if (pistonMode === 'ratelimit') {
      return route.fulfill({ status: 429, json: { message: 'Requests limited to 5 requests per 1s' } });
    }
    if (pistonMode === 'compile-error') {
      return route.fulfill({
        json: {
          language: 'c++',
          version: '10.2.0',
          compile: { stdout: '', stderr: "main.cpp:3:5: error: expected ';' before '}'", code: 1, signal: null },
          run: { stdout: '', stderr: '', code: 0, signal: null },
        },
      });
    }
    if (pistonMode === 'timeout-kill') {
      return route.fulfill({
        json: { language: 'python', version: '3.12.0', run: { stdout: '', stderr: '', code: null, signal: 'SIGKILL' } },
      });
    }
    const sent = pistonCalls[pistonCalls.length - 1];
    return route.fulfill({
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

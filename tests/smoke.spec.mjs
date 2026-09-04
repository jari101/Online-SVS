// tests/smoke.spec.mjs — end-to-end smoke test.
// Starts a static server for the repository, opens the app in headless Chromium and clicks
// through the main features. Monaco is served from the local npm copy so the test also
// works without internet access.

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
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
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
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(err));
  page.on('dialog', (dialog) => dialog.accept());
  await page.addInitScript((base) => {
    window.SVS_MONACO_BASE = base;
  }, `${BASE}/tests/node_modules/monaco-editor/min`);

  const editorValue = () => page.evaluate(() => window.SVS.getEditor().getValue());
  const activeTabName = () => page.textContent('.tab.active .tab-name');

  console.log('Online SVS smoke test');

  await step('page loads and Monaco mounts', async () => {
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
    assert.equal(await page.textContent('.app-name'), 'Online SVS');
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
    assert.equal(await activeTabName(), 'untitled.py');
    assert.match(await editorValue(), /remember me/);
  });

  await step('open the sample project: explorer shows it and index.html opens', async () => {
    await page.click('#btn-open-menu');
    await page.click('button[data-command="open-sample"]');
    await page.waitForSelector('.tree-row[data-path="index.html"]');
    await page.waitForSelector('.tab.active:has-text("index.html")');
    assert.ok(await page.$('#app.mode-folder'), 'app should be in folder mode');
    assert.equal(await page.$('.tab.scratch'), null, 'scratch tab should be gone');
    assert.match(await page.textContent('#status-folder'), /sample-site/);
  });

  await step('expanding a folder and clicking a file opens a tab', async () => {
    await page.click('.tree-row[data-path="css"]');
    await page.click('.tree-row[data-path="css/style.css"]');
    await page.waitForSelector('.tab.active:has-text("style.css")');
    assert.match(await editorValue(), /--accent/);
    assert.equal(await page.textContent('#status-language'), 'CSS');
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

  await step('Problems tab lists a JavaScript syntax error', async () => {
    await page.click('.tree-row[data-path="js"]');
    await page.click('.tree-row[data-path="js/app.js"]');
    await page.waitForSelector('.tab.active:has-text("app.js")');
    await page.evaluate(() => window.SVS.getEditor().setValue('function broken( {\n'));
    await page.waitForSelector('#problems-count:not([hidden])', { timeout: 20000 });
    await page.click('.panel-tab[data-tab="problems"]');
    const text = await page.textContent('#problems-list');
    assert.match(text, /app\.js/);
    assert.ok(Number(await page.textContent('#problems-count')) >= 1);
  });

  await step('closing a tab with unsaved changes asks first (dialog auto-accepted)', async () => {
    await page.click('.tab.active .tab-close');
    await page.waitForSelector('.tab.active:has-text("notes.txt")');
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
    assert.ok(await page.$('#app.hide-sidebar'));
    await page.keyboard.press('Control+b');
    assert.equal(await page.$('#app.hide-sidebar'), null);
    await page.keyboard.press('Control+j');
    assert.ok(await page.$('#app.hide-panel'));
    await page.keyboard.press('Control+j');
    assert.equal(await page.$('#app.hide-panel'), null);
  });

  await step('screenshot of the folder mode', async () => {
    await page.click('.activity[data-view="explorer"]'); // back from Settings to the Explorer
    await page.click('.tree-row[data-path="index.html"]');
    await page.waitForSelector('.tab.active:has-text("index.html")');
    await sleep(300);
    await page.screenshot({ path: path.join(SHOTS, 'phase1-folder.png') });
  });

  await step('closing the folder returns to the scratch file', async () => {
    await page.click('#btn-open-menu');
    await page.click('button[data-command="close-folder"]');
    await page.waitForSelector('.tab.scratch');
    assert.equal(await activeTabName(), 'untitled.py');
    assert.ok(await page.$('#app.mode-scratch'));
    await page.screenshot({ path: path.join(SHOTS, 'phase1-scratch.png') });
  });

  await step('no JavaScript errors were thrown by the page', async () => {
    assert.equal(pageErrors.length, 0, pageErrors.map((e) => e.message).join('\n'));
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

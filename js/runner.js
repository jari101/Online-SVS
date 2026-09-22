// js/runner.js — the Run button.
//
// There are two places your code can run, and this file decides which one and reports back.
//
//   In your browser   JavaScript, TypeScript and Python run in a Web Worker in this tab.
//                     Nothing is uploaded, it works offline, and Stop really stops a program.
//   On your runner    C, C++, Java, C#, Go, Rust and the rest need a compiler, so they go to
//                     a Piston server whose address you put in Settings. This is the only
//                     time your code leaves the browser, and only when you press Run.
//
// The free public Piston closed to the public on 15 February 2026, so there is no address
// built in: a language that needs one says so and opens Settings for you.

import { state, emit, activeFile } from './state.js';
import * as fs from './fs/index.js';
import { baseName } from './fs/util.js';
import {
  LANGUAGES, languageForPath, isRunnable, runsInBrowser, entryFileName, companionPaths,
  definesEntryPoint,
} from './languages.js';
import { openTextOf } from './editor.js';
import { clearOutput, appendOutput, showPanelTab, setRunLocation } from './panel.js';
import { refreshLanguageAvailability } from './scratch.js';
import { showSidebarView } from './layout.js';
import { RunError } from './runners/run-error.js';
import { runInBrowser } from './runners/browser.js';
import { runOnServer, serverRunner } from './runners/piston.js';
import { icons } from './icons.js';
import { $, joinNames } from './dom.js';

const MAX_FILES = 12;                  // the entry file plus its companions
const MAX_TOTAL_BYTES = 64 * 1024;     // keep uploads small; Piston rejects very large ones
const SERVER_TIMEOUT = 30000;          // waiting on somebody else's machine
const BROWSER_TIMEOUT = 60000;         // long enough for an endless loop to be obvious

let inFlight = null;    // AbortController for the run in progress
let timedOut = false;   // false after an abort means you pressed Stop yourself
let runButton = null;
let runLabel = null;
let runIcon = null;

/**
 * Names that should never be uploaded just because they sit next to the file you ran.
 * Running one file is not consent to send the keys lying beside it. This applies to the
 * server only: a run inside the browser sends nothing anywhere, so holding a helper back
 * would just break the program for no gain.
 */
function looksSensitive(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith('.env') || lower.startsWith('id_rsa') || lower.startsWith('id_ed25519')) return true;
  if (/\.(pem|key|pfx|p12|keystore|jks)$/.test(lower)) return true;
  return ['secret', 'credential', 'password', 'token', 'apikey', 'api_key'].some((word) => lower.includes(word));
}

export function initRunner() {
  runButton = $('btn-run');
  runIcon = runButton.querySelector('.btn-run-icon');
  runLabel = runButton.querySelector('.btn-run-label');
  runButton.removeAttribute('aria-disabled');
  setRunning(false);
  refreshLanguageAvailability();
}

/* ---------- Deciding where a language runs ---------- */

/** 'browser', 'server', or null when nothing can run it yet. */
function whereItRuns(lang) {
  if (!isRunnable(lang)) return null;
  if (runsInBrowser(lang)) return 'browser';
  return serverRunner() ? 'server' : null;
}

/** The names of the languages that always work, for the "here is a way out" message. */
function browserLanguageNames() {
  return joinNames(LANGUAGES.filter(runsInBrowser).map((l) => l.name));
}

/** Spelled out in full, because a raw error code teaches nobody anything. */
function noRunnerError(lang) {
  return new RunError(
    `${lang.name} cannot run inside your browser: it has to be compiled first.\n\n`
    + '  Two ways to fix this:\n'
    + `  • Switch to ${browserLanguageNames()}, which run here with no setup\n`
    + '  • Add your own code runner in Settings ⚙ — docs/code-runner.md walks through it\n\n'
    + 'The free public Piston service closed to the public in February 2026, which is why '
    + 'there is no address built in any more.',
    'settings',
  );
}

/* ---------- Building the request ---------- */

const byteLength = (text) => new TextEncoder().encode(text).length;

/** Work out what to run: the language, the entry file and any companion files beside it. */
async function collectRequest() {
  const file = activeFile();
  if (!file) throw new RunError('Open a file first, then press Run.');
  if (file.kind !== 'text') throw new RunError(`"${file.name}" is a binary file, so it cannot be run.`);

  const source = file.model.getValue();
  const lang = file.scratch ? file.language : languageForPath(file.path);
  if (!lang) {
    throw new RunError(
      `Online SVS does not know how to run "${file.name}". `
      + `It can run: ${LANGUAGES.filter(isRunnable).map((l) => l.name).join(', ')}.`,
    );
  }
  if (!isRunnable(lang)) {
    throw new RunError('HTML is not run as a program. Press Go Live to see it in the preview instead.');
  }
  if (!source.trim()) throw new RunError(`"${file.name}" is empty, so there is nothing to run.`);

  const where = whereItRuns(lang);
  if (!where) throw noRunnerError(lang);
  const remote = where === 'server';

  const entryName = entryFileName(lang, source, file.scratch ? null : baseName(file.path));
  const files = [{ name: entryName, content: source }];
  let total = byteLength(source);
  if (remote && total > MAX_TOTAL_BYTES) {
    throw new RunError(`"${file.name}" is larger than ${Math.round(MAX_TOTAL_BYTES / 1024)} KB, which is too big to send.`);
  }

  // Files next to it in the same folder, so #include "utils.h" and import helper find them.
  let skipped = 0;
  let withheld = 0;
  if (!file.scratch && state.tree) {
    for (const path of companionPaths(state.tree, file.path, lang)) {
      const name = baseName(path);
      if (files.some((f) => f.name === name)) continue;
      if (remote && looksSensitive(name)) {
        withheld += 1;
        continue;
      }
      if (remote && files.length >= MAX_FILES) {
        skipped += 1;
        continue;
      }
      let content;
      try {
        const open = openTextOf(path);
        content = open !== null ? open : await fs.readText(path);
      } catch {
        continue; // unreadable companion: run without it rather than failing outright
      }
      // A neighbouring exercise with its own main would break the build, so leave it out.
      if (definesEntryPoint(lang, content)) continue;
      const size = byteLength(content);
      if (remote && total + size > MAX_TOTAL_BYTES) {
        skipped += 1;
        continue;
      }
      total += size;
      files.push({ name, content });
    }
  }

  return { lang, where, files, entryName, skipped, withheld };
}

/* ---------- Running ---------- */

export async function run() {
  if (!runButton) {
    appendOutput('The editor is still loading. Try again in a moment.\n', 'error');
    return;
  }
  // Pressing the button while a run is under way stops the program.
  if (state.running) {
    inFlight?.abort();
    return;
  }

  showPanelTab('output');
  clearOutput();
  setRunning(true);
  timedOut = false;
  inFlight = new AbortController();

  let timer = null;
  let budget = SERVER_TIMEOUT;
  const startClock = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      inFlight?.abort();
    }, budget);
  };
  startClock();

  try {
    const { lang, where, files, entryName, skipped, withheld } = await collectRequest();
    budget = where === 'browser' ? BROWSER_TIMEOUT : SERVER_TIMEOUT;
    startClock();
    setRunLocation({ where, engine: lang.name });

    const onOutput = (text, stream) => appendOutput(text, stream === 'stderr' ? 'stderr' : '');
    // Any sign of life — Python downloading, the server answering — earns a fresh deadline.
    const onStatus = (text) => {
      startClock();
      if (text) appendOutput(text, 'muted');
    };
    // The version is only known once the runtime is up, so the header waits for it.
    const onEngine = (engine, host = null) => {
      setRunLocation({ where, engine, host });
      appendOutput(`Running ${entryName} with ${engine}\n`, 'info');
      describeFiles(files, where, skipped, withheld);
    };

    const started = performance.now();
    const request = { lang, files, entryName, stdin: state.stdin, onOutput, onStatus, onEngine, signal: inFlight.signal };
    const result = where === 'browser' ? await runInBrowser(request) : await runOnServer(request);
    renderFooter(result, (performance.now() - started) / 1000);
  } catch (err) {
    if (err instanceof RunError) {
      printProblem(err.message);
      if (err.action === 'settings') offerSettings();
    } else if (err.name === 'AbortError') {
      appendOutput(stoppedMessage(budget), 'error');
    } else {
      console.error(err);
      appendOutput(`Something went wrong: ${err.message}\n`, 'error');
    }
  } finally {
    clearTimeout(timer);
    inFlight = null;
    setRunning(false);
    // A run is when we find out what a code runner actually offers, so the language
    // dropdown can stop guessing.
    refreshLanguageAvailability();
    emit('run-finished');
  }
}

/** Name every file that travels with your code, so nothing moves without you seeing it. */
function describeFiles(files, where, skipped, withheld) {
  const extras = files.slice(1).map((f) => f.name);
  if (extras.length) {
    const verb = where === 'server' ? 'Also sending from the same folder' : 'Also using from the same folder';
    appendOutput(`${verb}: ${extras.join(', ')}\n`, 'info');
  }
  if (skipped > 0) {
    appendOutput(`${skipped} neighbouring file${skipped === 1 ? ' was' : 's were'} left out to keep the request small.\n`, 'muted');
  }
  if (withheld > 0) {
    appendOutput(
      `${withheld} neighbouring file${withheld === 1 ? ' was' : 's were'} not sent because the name suggests it holds secrets.\n`,
      'muted',
    );
  }
  appendOutput('\n');
}

/**
 * Say what went wrong in red, then how to fix it in ordinary text. A whole paragraph of red
 * reads as one big alarm; the part you are meant to act on should not look like more of it.
 */
function printProblem(message) {
  const [headline, ...rest] = message.split('\n');
  appendOutput(`${headline}\n`, 'error');
  if (rest.length) appendOutput(`${rest.join('\n')}\n`);
}

function stoppedMessage(budget) {
  if (!timedOut) return '\nStopped.\n';
  return `\nNothing happened for ${budget / 1000} seconds, so the run was given up. `
    + (budget === BROWSER_TIMEOUT
      ? 'A loop that never ends is the usual reason.\n'
      : 'The program may still be running on your code runner.\n');
}

/** Say how the program ended: the exit code, how long it took, and why if it was killed. */
function renderFooter(result, seconds) {
  const time = `${seconds.toFixed(2)} s`;
  if (result.compileFailed) {
    appendOutput(`\nThe program did not compile (exit code ${result.code}).\n`, 'error');
    return;
  }
  if (result.signal) {
    const reason = result.signal === 'SIGKILL'
      ? ' Your code runner stops programs that run too long or use too much memory.'
      : '';
    appendOutput(`\nThe program was stopped by ${result.signal} after ${time}.${reason}\n`, 'error');
    return;
  }
  const code = result.code ?? 0;
  appendOutput(`\nExit code ${code} · ${time}\n`, code === 0 ? 'success' : 'error');
}

/** Take the user to the one place that fixes this. */
function offerSettings() {
  showSidebarView('settings');
  emit('focus-runner-setting');
}

/* ---------- Button state ---------- */

function setRunning(running) {
  state.running = running;
  runButton.classList.toggle('running', running);
  runButton.setAttribute('aria-busy', String(running));
  runIcon.innerHTML = running ? icons.stop : icons.play;
  runLabel.textContent = running ? 'Running…' : 'Run';
  runButton.title = running ? 'Stop the program' : 'Run the current file (Ctrl+Enter)';
  emit('running', running);
}

// js/runner.js — the Run button.
//
// Your code is sent to Piston (https://github.com/engineer-man/piston), a free service that
// compiles and runs programs in a sandbox and sends back what they printed. Online SVS has no
// server of its own, so this one request is the only time your code leaves the browser.
// Point CONFIG.pistonUrl at your own Piston instance if you would rather it did not.

import { CONFIG } from './config.js';
import { state, emit, activeFile } from './state.js';
import * as fs from './fs/index.js';
import { baseName } from './fs/util.js';
import {
  LANGUAGES, languageForPath, isRunnable, entryFileName, companionPaths, definesEntryPoint,
} from './languages.js';
import { openTextOf } from './editor.js';
import { clearOutput, appendOutput, showPanelTab } from './panel.js';
import { markLanguageAvailability } from './scratch.js';
import { toast } from './toast.js';
import { icons } from './icons.js';
import { $ } from './dom.js';

const MAX_FILES = 12;                 // the entry file plus its companions
const MAX_TOTAL_BYTES = 64 * 1024;    // keep requests small; Piston rejects very large ones
const REQUEST_TIMEOUT = 30000;        // covers the whole run, both requests together

let runtimes = null;   // the service's language list, once it has answered us
let inFlight = null;   // AbortController for the run in progress
let cancelled = false;
let timedOut = false;
let runButton = null;
let runLabel = null;
let runIcon = null;

/** An error with a message meant for the user rather than the console. */
class RunError extends Error {}

/**
 * Names that should never be uploaded just because they sit next to the file you ran.
 * Running one file is not consent to send the keys lying beside it.
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
}

/* ---------- The Piston service ---------- */

/** The service's languages, asked for once and then remembered for the session. */
async function loadRuntimes(signal) {
  if (runtimes) return runtimes;

  let response;
  try {
    response = await fetch(`${CONFIG.pistonUrl}/runtimes`, { headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new RunError(
      `Could not reach the code-running service at ${CONFIG.pistonUrl}. `
      + 'Check your internet connection. Some networks and browser extensions block it; '
      + 'you can also run your own Piston and point the app at it.',
    );
  }
  if (response.status === 429) throw rateLimitError();
  if (!response.ok) throw new RunError(`The code-running service answered ${response.status} ${response.statusText}.`);

  const list = await response.json();
  const best = new Map(); // language name or alias -> { language, version }
  for (const runtime of list) {
    for (const name of [runtime.language, ...(runtime.aliases || [])]) {
      const known = best.get(name);
      if (!known || isNewer(runtime.version, known.version)) {
        best.set(name, { language: runtime.language, version: runtime.version });
      }
    }
  }

  runtimes = best;
  // Now that we know what exists, say so in the language dropdown.
  markLanguageAvailability((lang) => !lang.piston || best.has(lang.piston));
  return runtimes;
}

/** Compare two version strings the way "10.2.0" beats "9.4.0". */
function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function rateLimitError() {
  return new RunError('The free code-running service allows only a few runs per second. Wait a moment and press Run again.');
}

/* ---------- Building the request ---------- */

const byteLength = (text) => new TextEncoder().encode(text).length;

/** Work out what to send: the language, the entry file and any companion files beside it. */
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

  const entryName = entryFileName(lang, source, file.scratch ? null : baseName(file.path));
  const files = [{ name: entryName, content: source }];
  let total = byteLength(source);
  if (total > MAX_TOTAL_BYTES) {
    throw new RunError(`"${file.name}" is larger than ${Math.round(MAX_TOTAL_BYTES / 1024)} KB, which is too big to send.`);
  }

  // Files next to it in the same folder, so #include "utils.h" and import helper work.
  let skipped = 0;
  let withheld = 0;
  if (!file.scratch && state.tree) {
    for (const path of companionPaths(state.tree, file.path, lang)) {
      const name = baseName(path);
      if (files.some((f) => f.name === name)) continue;
      if (looksSensitive(name)) {
        withheld += 1;
        continue;
      }
      if (files.length >= MAX_FILES) {
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
      if (total + size > MAX_TOTAL_BYTES) {
        skipped += 1;
        continue;
      }
      total += size;
      files.push({ name, content });
    }
  }

  return { lang, files, entryName, skipped, withheld };
}

/* ---------- Running ---------- */

export async function run() {
  if (!runButton) {
    toast('The editor is still loading. Try again in a moment.', 'warning');
    return;
  }
  // Pressing the button while a run is under way stops waiting for the answer.
  if (state.running) {
    cancelled = true;
    inFlight?.abort();
    return;
  }

  showPanelTab('output');
  clearOutput();
  setRunning(true);
  cancelled = false;
  timedOut = false;
  inFlight = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    inFlight?.abort();
  }, REQUEST_TIMEOUT);

  try {
    const { lang, files, entryName, skipped, withheld } = await collectRequest();
    if (!runtimes) appendOutput('Looking up the code-running service…\n', 'muted');

    const available = await loadRuntimes(inFlight.signal);
    const runtime = available.get(lang.piston);
    if (!runtime) {
      throw new RunError(`The code-running service does not currently offer ${lang.name}. Try another language.`);
    }

    clearOutput();
    appendOutput(`Running ${entryName} with ${lang.name} ${runtime.version}\n`, 'info');
    // Name every file that leaves the browser, so nothing is sent without you seeing it.
    const extras = files.slice(1).map((f) => f.name);
    if (extras.length) {
      appendOutput(`Also sending from the same folder: ${extras.join(', ')}\n`, 'info');
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

    const started = performance.now();
    const result = await execute(runtime, files, state.stdin, inFlight.signal);
    renderResult(result, (performance.now() - started) / 1000);
  } catch (err) {
    if (err instanceof RunError) {
      appendOutput(`${err.message}\n`, 'error');
    } else if (err.name === 'AbortError') {
      appendOutput(
        timedOut
          ? `\nNo answer after ${REQUEST_TIMEOUT / 1000} seconds, so waiting was given up. The program may still be running on the service.\n`
          : '\nStopped waiting for the result. The program may still finish on the service.\n',
        'error',
      );
    } else {
      console.error(err);
      appendOutput(`Something went wrong: ${err.message}\n`, 'error');
    }
  } finally {
    clearTimeout(timer);
    inFlight = null;
    setRunning(false);
    emit('run-finished');
  }
}

async function execute(runtime, files, stdin, signal) {
  let response;
  try {
    response = await fetch(`${CONFIG.pistonUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        language: runtime.language,
        version: runtime.version,
        files,
        stdin: stdin || '',
      }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new RunError(
      `Could not reach the code-running service at ${CONFIG.pistonUrl}. Check your internet connection and try again.`,
    );
  }

  if (response.status === 429) throw rateLimitError();
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let message = detail;
    try {
      message = JSON.parse(detail).message || detail;
    } catch { /* not JSON: use the raw text */ }
    throw new RunError(`The code-running service refused the request (${response.status}). ${message}`.trim());
  }
  // Await here rather than returning the promise, so the timeout still covers the download.
  const result = await response.json();
  return result;
}

/* ---------- Showing the result ---------- */

function renderResult(result, seconds) {
  const compile = result.compile;
  if (compile && (compile.stdout || compile.stderr || compile.code)) {
    if (compile.stdout) appendOutput(compile.stdout);
    if (compile.stderr) appendOutput(compile.stderr, 'stderr');
    if (compile.code !== 0) {
      appendOutput(`\nThe program did not compile (exit code ${compile.code}).\n`, 'error');
      return;
    }
    appendOutput('\n');
  }

  const program = result.run || {};
  if (program.stdout) appendOutput(program.stdout);
  if (program.stderr) appendOutput(program.stderr, 'stderr');
  if (!program.stdout && !program.stderr) appendOutput('The program printed nothing.\n', 'muted');

  const lastChar = (program.stdout || program.stderr || '\n').slice(-1);
  if (lastChar !== '\n') appendOutput('\n');

  const time = `${seconds.toFixed(2)} s`;
  if (program.signal) {
    const reason = program.signal === 'SIGKILL'
      ? ' The service stops programs that run too long or use too much memory.'
      : '';
    appendOutput(`\nThe program was stopped by ${program.signal} after ${time}.${reason}\n`, 'error');
    return;
  }
  const code = program.code ?? 0;
  appendOutput(`\nExit code ${code} · ${time}\n`, code === 0 ? 'success' : 'error');
}

/* ---------- Button state ---------- */

function setRunning(running) {
  state.running = running;
  runButton.classList.toggle('running', running);
  runButton.setAttribute('aria-busy', String(running));
  runIcon.innerHTML = running ? icons.stop : icons.play;
  runLabel.textContent = running ? 'Running…' : 'Run';
  runButton.title = running ? 'Stop waiting for the result' : 'Run the current file (Ctrl+Enter)';
  emit('running', running);
}

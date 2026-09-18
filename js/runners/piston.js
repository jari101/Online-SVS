// js/runners/piston.js — your own code runner, for the languages a browser cannot compile:
// C, C++, Java, C#, Go, Rust, Kotlin, Swift, PHP, Ruby and Bash.
//
// This talks to Piston (https://github.com/engineer-man/piston), which compiles and runs a
// program in a sandbox and sends back what it printed. The free public Piston closed to the
// public on 15 February 2026, so there is no address built in any more: you give Online SVS
// the address of a Piston you run yourself, in Settings. Until you do, these languages
// explain themselves rather than failing with a raw error code.
//
// This is the one and only place your code leaves the browser, and only when you press Run.

import { state } from '../state.js';
import { RunError } from './run-error.js';

let cache = null; // { url, runtimes: Map } — the language list, remembered per address

/** The code runner you configured, or null when Settings has no address in it. */
export function serverRunner() {
  const url = (state.settings.runnerUrl || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  return { url, key: (state.settings.runnerKey || '').trim() };
}

/** Forget the remembered language list (the address or key changed). */
export function forgetRuntimes() {
  cache = null;
}

function headers(runner, extra = {}) {
  const result = { Accept: 'application/json', ...extra };
  // A public Piston that whitelisted you issues a key; one you run yourself needs none.
  if (runner.key) result.Authorization = runner.key;
  return result;
}

function unreachable(runner, err) {
  return new RunError(
    `Could not reach your code runner at ${runner.url}. ${err?.message || ''}\n`
    + 'Check that it is running and that it allows requests from this page (CORS). '
    + 'You can change the address in Settings.',
    'settings',
  );
}

function refused(status, statusText, detail) {
  let message = detail || '';
  try {
    message = JSON.parse(detail).message || detail;
  } catch { /* not JSON: use the raw text */ }
  if (status === 401 || status === 403) {
    return new RunError(
      `Your code runner refused the request (${status}). ${message}\n`
      + 'If it needs a key, add it in Settings; if you run your own Piston, it should need none.',
      'settings',
    );
  }
  return new RunError(`Your code runner answered ${status} ${statusText}. ${message}`.trim());
}

const rateLimited = () => new RunError(
  'Your code runner is limiting how often it will run something. Wait a moment and press Run again.',
);

/* ---------- Which languages it offers ---------- */

/** Ask the runner what it can run. Asked once per address and then remembered. */
export async function loadRuntimes(signal) {
  const runner = serverRunner();
  if (!runner) return null;
  if (cache && cache.url === runner.url) return cache.runtimes;

  let response;
  try {
    response = await fetch(`${runner.url}/runtimes`, { headers: headers(runner), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw unreachable(runner, err);
  }
  if (response.status === 429) throw rateLimited();
  if (!response.ok) throw refused(response.status, response.statusText, await response.text().catch(() => ''));

  const list = await response.json();
  if (!Array.isArray(list)) throw new RunError(`${runner.url} did not answer with a list of languages. Is it really a Piston server?`, 'settings');

  const best = new Map(); // language name or alias -> { language, version }
  for (const runtime of list) {
    for (const name of [runtime.language, ...(runtime.aliases || [])]) {
      const known = best.get(name);
      if (!known || isNewer(runtime.version, known.version)) {
        best.set(name, { language: runtime.language, version: runtime.version });
      }
    }
  }
  cache = { url: runner.url, runtimes: best };
  return best;
}

/** The language list we already have, without asking for it. */
export function knownRuntimes() {
  const runner = serverRunner();
  return runner && cache && cache.url === runner.url ? cache.runtimes : null;
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

/**
 * Try an address from the Settings form and report what came back, in plain words.
 * Returns { ok, message, count }.
 */
export async function testRunner(url, key, signal) {
  const address = String(url || '').trim().replace(/\/+$/, '');
  if (!address) return { ok: false, message: 'Fill in the address first.' };
  if (!/^https?:\/\//i.test(address)) return { ok: false, message: 'The address should start with http:// or https://' };

  let response;
  try {
    response = await fetch(`${address}/runtimes`, {
      headers: key ? { Accept: 'application/json', Authorization: key } : { Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { ok: false, message: 'Could not reach it. Check the address, that the server is running, and that it allows this page (CORS).' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, message: `It refused us (${response.status}). It probably wants a key, or a different one.` };
  }
  if (!response.ok) return { ok: false, message: `It answered ${response.status} ${response.statusText}.` };

  let list;
  try {
    list = await response.json();
  } catch {
    return { ok: false, message: 'It answered, but not with JSON. Is this really a Piston address?' };
  }
  if (!Array.isArray(list)) return { ok: false, message: 'It answered, but not with a list of languages. Is this really a Piston address?' };

  const names = new Set(list.map((r) => r.language));
  return { ok: true, count: names.size, message: `Connected. It can run ${names.size} language${names.size === 1 ? '' : 's'}.` };
}

/* ---------- Running ---------- */

/**
 * Send one program to the runner and print what it said.
 * Returns { code, signal, engine, host, compileFailed }.
 */
export async function runOnServer({ lang, files, stdin, onOutput, onStatus, onEngine, signal }) {
  const runner = serverRunner();
  if (!runner) throw new RunError('No code runner is set up yet.', 'settings');

  onStatus?.('Asking your code runner which languages it has…\n');
  const runtimes = await loadRuntimes(signal);
  const runtime = runtimes.get(lang.piston);
  if (!runtime) {
    throw new RunError(
      `Your code runner at ${runner.url} does not offer ${lang.name}. `
      + 'A full Piston install has it; a trimmed one may not.',
      'settings',
    );
  }
  onEngine?.(`${lang.name} ${runtime.version}`, hostOf(runner.url));

  let response;
  try {
    response = await fetch(`${runner.url}/execute`, {
      method: 'POST',
      headers: headers(runner, { 'Content-Type': 'application/json' }),
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
    throw unreachable(runner, err);
  }

  if (response.status === 429) throw rateLimited();
  if (!response.ok) throw refused(response.status, response.statusText, await response.text().catch(() => ''));

  // Await here rather than returning the promise, so the timeout still covers the download.
  const result = await response.json();
  return {
    ...report(result, onOutput),
    engine: `${lang.name} ${runtime.version}`,
    host: hostOf(runner.url),
  };
}

/** Print the compiler's and the program's output, and say how it ended. */
function report(result, onOutput) {
  const compile = result.compile;
  if (compile && (compile.stdout || compile.stderr || compile.code)) {
    if (compile.stdout) onOutput(compile.stdout, 'stdout');
    if (compile.stderr) onOutput(compile.stderr, 'stderr');
    if (compile.code !== 0) return { code: compile.code, signal: null, compileFailed: true };
    onOutput('\n', 'stdout');
  }

  const program = result.run || {};
  if (program.stdout) onOutput(program.stdout, 'stdout');
  if (program.stderr) onOutput(program.stderr, 'stderr');
  return { code: program.code ?? 0, signal: program.signal || null, compileFailed: false };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}


/* js/runners/js.worker.js — runs your JavaScript inside a Web Worker.
 *
 * A Web Worker is a second JavaScript thread with no access to the page: no document, no
 * cookies, no handle on your files. That makes it a reasonable sandbox for running a program
 * you are writing, and — because it is a separate thread — the Stop button can genuinely
 * kill a runaway loop by terminating the worker, which the old server-based runner could not.
 *
 * The worker speaks two messages:
 *   in   { type: 'run', files: [{ name, content }], entryName, stdin }
 *   out  { type: 'output', text, stream }   as the program prints
 *        { type: 'done', code }             when it finishes
 *
 * Nothing here talks to the network. The code you run never leaves the browser.
 */

/* ---------- stdin (the Input tab) ---------- */

let stdinLines = [];
let stdinIndex = 0;

function nextLine() {
  return stdinIndex < stdinLines.length ? stdinLines[stdinIndex++] : null;
}

/* ---------- stdout and stderr ---------- */

function write(text, stream) {
  self.postMessage({ type: 'output', text, stream });
}

/**
 * Turn a console argument into text the way a terminal would show it.
 * Strings print as they are; everything else is inspected.
 */
function format(value, seen = new Set()) {
  if (typeof value === 'string') return value;
  return inspect(value, seen, 0);
}

function inspect(value, seen, depth) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'string') return depth === 0 ? value : JSON.stringify(value);
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
  if (type === 'symbol') return value.toString();
  if (type === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (seen.has(value)) return '[Circular]';
  if (depth > 4) return Array.isArray(value) ? '[Array]' : '[Object]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[ ${value.map((v) => inspect(v, seen, depth + 1)).join(', ')} ]`;
    }
    if (value instanceof Map) {
      const items = [...value].map(([k, v]) => `${inspect(k, seen, depth + 1)} => ${inspect(v, seen, depth + 1)}`);
      return `Map(${value.size}) { ${items.join(', ')} }`;
    }
    if (value instanceof Set) {
      return `Set(${value.size}) { ${[...value].map((v) => inspect(v, seen, depth + 1)).join(', ')} }`;
    }
    const entries = Object.entries(value).map(([k, v]) => `${k}: ${inspect(v, seen, depth + 1)}`);
    const name = value.constructor && value.constructor.name !== 'Object' ? `${value.constructor.name} ` : '';
    return entries.length ? `${name}{ ${entries.join(', ')} }` : `${name}{}`;
  } finally {
    seen.delete(value);
  }
}

const line = (args) => `${args.map((a) => format(a)).join(' ')}\n`;

const consoleShim = {
  log: (...args) => write(line(args), 'stdout'),
  info: (...args) => write(line(args), 'stdout'),
  debug: (...args) => write(line(args), 'stdout'),
  dir: (...args) => write(line(args), 'stdout'),
  error: (...args) => write(line(args), 'stderr'),
  warn: (...args) => write(line(args), 'stderr'),
  trace: (...args) => write(line(['Trace:', ...args]), 'stderr'),
  table: (...args) => write(line(args), 'stdout'),
  group: (...args) => write(line(args), 'stdout'),
  groupEnd: () => {},
  assert: (ok, ...args) => {
    if (!ok) write(line(['Assertion failed:', ...args]), 'stderr');
  },
  time: () => {},
  timeEnd: () => {},
  count: () => {},
};

// `console` is replaceable in every browser we support, but assigning onto the existing
// object is the safe fallback if one day it is not.
try {
  self.console = consoleShim;
} catch {
  /* left to the Object.assign below */
}
if (self.console !== consoleShim) Object.assign(self.console, consoleShim);

/* ---------- The bits of Node that beginner programs reach for ---------- */

/** Thrown by process.exit(): caught below so the program stops without an error message. */
class ExitSignal extends Error {
  constructor(code) {
    super('process.exit');
    this.code = code;
  }
}

/**
 * Node keeps a program alive until its timers have run, so `setTimeout(print, 1000)` prints
 * before the program is called finished. A worker would otherwise be torn down the moment the
 * last line of the file was reached, losing that output, so we count the timers that are still
 * waiting and treat the program as finished only once none are left.
 *
 * setInterval repeats forever and is deliberately never counted down: like Node, a program
 * that sets one runs until it is cleared, the timeout expires or you press Stop.
 */
function installTimers(reportAsync) {
  const rawSetTimeout = self.setTimeout.bind(self);
  const rawClearTimeout = self.clearTimeout.bind(self);
  const rawSetInterval = self.setInterval.bind(self);
  const rawClearInterval = self.clearInterval.bind(self);
  const waitingTimeouts = new Set();
  const waitingIntervals = new Set();
  let onIdle = null;

  const idle = () => waitingTimeouts.size === 0 && waitingIntervals.size === 0;
  const settle = () => {
    if (idle() && onIdle) {
      const resolve = onIdle;
      onIdle = null;
      resolve();
    }
  };
  const guard = (fn) => (...args) => {
    try {
      fn(...args);
    } catch (err) {
      reportAsync(err);
    }
  };

  self.setTimeout = (fn, delay, ...args) => {
    let id = null;
    id = rawSetTimeout((...called) => {
      waitingTimeouts.delete(id);
      guard(fn)(...called);
      settle();
    }, delay, ...args);
    waitingTimeouts.add(id);
    return id;
  };
  self.clearTimeout = (id) => {
    waitingTimeouts.delete(id);
    rawClearTimeout(id);
    settle();
  };
  self.setInterval = (fn, delay, ...args) => {
    const id = rawSetInterval(guard(fn), delay, ...args);
    waitingIntervals.add(id);
    return id;
  };
  self.clearInterval = (id) => {
    waitingIntervals.delete(id);
    rawClearInterval(id);
    settle();
  };

  return {
    finish: () => {
      waitingTimeouts.clear();
      waitingIntervals.clear();
      settle();
    },
    whenIdle: () => (idle() ? Promise.resolve() : new Promise((resolve) => { onIdle = resolve; })),
  };
}

function installGlobals() {
  const readline = () => nextLine();

  const input = (promptText = '') => {
    if (promptText) write(String(promptText), 'stdout');
    const value = nextLine();
    if (value === null) throw new Error('EOF: the Input tab has no more lines to read.');
    return value;
  };

  Object.assign(self, {
    readline,
    readLine: readline,
    input,
    prompt: input,
    process: {
      argv: ['node', 'main.js'],
      env: {},
      platform: 'browser',
      exitCode: 0,
      stdout: { write: (text) => { write(String(text), 'stdout'); return true; } },
      stderr: { write: (text) => { write(String(text), 'stderr'); return true; } },
      exit: (code = 0) => { throw new ExitSignal(code); },
    },
  });
}

/* ---------- Turning the files into something `import` can load ---------- */

// Matches the quoted path in `from './x.js'`, `import './x.js'` and `import('./x.js')`.
// A specifier is only rewritten when it names one of the files that came with the program,
// so an ordinary string that happens to look like one is left alone unless it matches exactly.
const SPECIFIER = /(\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g;

/** './helper' and './helper.js' both mean the file called helper.js. */
function resolveName(spec, names) {
  if (/^[a-z]+:/i.test(spec) || spec.startsWith('/')) return null; // a URL or absolute path
  const bare = spec.replace(/^\.\//, '');
  if (bare.includes('/')) return null; // only files in the same folder travel with your code
  for (const candidate of [bare, `${bare}.js`, `${bare}.mjs`, `${bare}.cjs`]) {
    if (names.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Give every file its own blob: URL and point the imports at each other.
 * Files that import each other in a circle cannot be linked this way, so their import is
 * left as written and the browser reports it — rare outside deliberately tangled code.
 */
function linkModules(files) {
  const contents = new Map(files.map((f) => [f.name, f.content]));
  const urls = new Map();     // file name -> blob: URL
  const sources = new Map();  // blob: URL -> file name, to put real names back in error traces
  const building = new Set();

  function build(name) {
    if (urls.has(name)) return urls.get(name);
    if (building.has(name)) return null;
    building.add(name);

    const code = contents.get(name).replace(SPECIFIER, (match, keyword, quote, spec) => {
      const target = resolveName(spec, contents);
      if (!target || target === name) return match;
      const url = build(target);
      return url ? `${keyword}${quote}${url}${quote}` : match;
    });

    building.delete(name);
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    urls.set(name, url);
    sources.set(url, name);
    return url;
  }

  for (const file of files) build(file.name);
  return { urls, sources };
}

/** Error traces point at blob: URLs, which mean nothing to you. Put the file names back. */
function readableStack(err, sources) {
  let text = err && err.stack ? String(err.stack) : String(err);
  for (const [url, name] of sources) text = text.split(url).join(name);
  // Whatever is left of our own plumbing is noise, so stop at the first frame from this file.
  return text.split('\n').filter((l) => !l.includes('js.worker.js')).join('\n');
}

/* ---------- Running ---------- */

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type !== 'run') return;

  stdinLines = message.stdin ? message.stdin.replace(/\n$/, '').split('\n') : [];
  stdinIndex = 0;
  installGlobals();

  const { urls, sources } = linkModules(message.files);
  let finished = false;
  let exitCode = null;

  const done = (code) => {
    if (finished) return;
    finished = true;
    self.postMessage({ type: 'done', code });
  };

  // An error thrown inside a timer happens long after the last line of the file has run,
  // so it cannot be caught around the import. Node prints it and stops with a failure.
  const reportAsync = (err) => {
    if (err instanceof ExitSignal) {
      exitCode = err.code;
      timers.finish();
      return;
    }
    write(`${readableStack(err, sources)}\n`, 'stderr');
    exitCode = 1;
    timers.finish();
  };

  const timers = installTimers(reportAsync);

  try {
    await import(urls.get(message.entryName));
    await timers.whenIdle();
    done(exitCode === null ? self.process.exitCode || 0 : exitCode);
  } catch (err) {
    if (err instanceof ExitSignal) {
      done(err.code);
      return;
    }
    write(`${readableStack(err, sources)}\n`, 'stderr');
    done(1);
  } finally {
    for (const url of urls.values()) URL.revokeObjectURL(url);
  }
};

/* js/runners/python.worker.js — runs your Python inside a Web Worker, using Pyodide.
 *
 * Pyodide is CPython itself compiled to WebAssembly: the same interpreter you would install
 * on your computer, running inside this browser tab. Your code is never uploaded anywhere,
 * it works with no internet once the download is cached, and there is no queue or rate limit.
 *
 * The download is about 12 MB and happens the first time you run Python. The worker is then
 * kept alive between runs, because booting the interpreter again would cost those seconds
 * every time. Pressing Stop terminates the worker, so the next run pays for the boot again.
 *
 * The worker speaks these messages:
 *   in   { type: 'run', files, entryName, stdin, base }
 *   out  { type: 'status', text }           progress while Python is downloading
 *        { type: 'ready', version }         the interpreter is up
 *        { type: 'output', text, stream }   as the program prints
 *        { type: 'done', code }             when it finishes
 *        { type: 'failed', message }        the interpreter itself could not start
 */

/** Where your program's files live inside Python's own little file system. */
const DIR = '/svs';

// sys.exit() travels two ways out of Pyodide: to the `await` below, where it becomes the
// program's exit code, and to Pyodide's own event loop, which reports it as a crash. The
// second one is noise about something already handled, so it is swallowed here.
self.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason?.type === 'SystemExit' || /^SystemExit\b/m.test(String(reason?.message || ''))) {
    event.preventDefault();
  }
});

let pyodide = null;
let booting = null;
let pythonVersion = null;

function send(message) {
  self.postMessage(message);
}

function write(text, stream) {
  if (text) send({ type: 'output', text, stream });
}

/* ---------- Starting the interpreter ---------- */

/**
 * Point Python's print() at the Output tab. `write` hands us the exact bytes, so a print()
 * with end='' or an input() prompt appears without a newline being invented for it. Older
 * builds only understand `batched`, which works a line at a time.
 */
function captureOutput() {
  const attach = (setter, stream) => {
    const decoder = new TextDecoder('utf-8');
    try {
      setter({
        write: (buffer) => {
          write(decoder.decode(buffer, { stream: true }), stream);
          return buffer.length;
        },
      });
    } catch {
      setter({ batched: (text) => write(`${text}\n`, stream) });
    }
  };
  attach((options) => pyodide.setStdout(options), 'stdout');
  attach((options) => pyodide.setStderr(options), 'stderr');
}

async function boot(base) {
  if (pyodide) return pyodide;
  if (booting) return booting;

  booting = (async () => {
    send({ type: 'status', text: 'Starting Python in your browser (about 12 MB the first time)…\n' });
    const { loadPyodide } = await import(`${base}pyodide.mjs`);
    // Pyodide chatters about its own start-up on stdout, so the Output tab is only
    // connected once it is up.
    pyodide = await loadPyodide({ indexURL: base, stdout: () => {}, stderr: () => {} });
    captureOutput();
    // Pyodide's own version ("314.0.7") is not a Python version anyone would recognise,
    // so ask the interpreter what it actually is.
    pythonVersion = pyodide.runPython(`
import os, sys
os.makedirs(${JSON.stringify(DIR)}, exist_ok=True)
if ${JSON.stringify(DIR)} not in sys.path:
    sys.path.insert(0, ${JSON.stringify(DIR)})
sys.version.split()[0]
`);
    return pyodide;
  })();

  try {
    return await booting;
  } finally {
    booting = null;
  }
}

/* ---------- Getting ready for one run ---------- */

// Run before every program: forget the last run's imports, hand the Input tab to sys.stdin
// and make input() read from it the way CPython does, EOFError and all.
const PRELUDE = `
import builtins, io, os, sys

for _svs_name in [
    _n for _n, _m in list(sys.modules.items())
    if str(getattr(_m, '__file__', '') or '').startswith(${JSON.stringify(`${DIR}/`)})
]:
    del sys.modules[_svs_name]

sys.stdin = io.StringIO(_svs_stdin)


def _svs_input(prompt=''):
    if prompt:
        sys.stdout.write(str(prompt))
        sys.stdout.flush()
    line = sys.stdin.readline()
    if line == '':
        raise EOFError('EOF when reading a line')
    return line.rstrip('\\n')


builtins.input = _svs_input
`;

/** Replace the files from the previous run so a deleted helper really is gone. */
function writeFiles(files) {
  for (const name of pyodide.FS.readdir(DIR)) {
    if (name === '.' || name === '..') continue;
    try {
      pyodide.FS.unlink(`${DIR}/${name}`);
    } catch {
      /* a directory or something we did not create: leave it alone */
    }
  }
  for (const file of files) {
    pyodide.FS.writeFile(`${DIR}/${file.name}`, file.content, { encoding: 'utf8' });
  }
}

/**
 * Push out whatever print() is still holding. Python buffers stdout, so a `print(x, end='')`
 * at the end of a program would otherwise sit in the buffer and turn up in the next run.
 */
function flush() {
  try {
    pyodide.runPython('import sys\nsys.stdout.flush()\nsys.stderr.flush()');
  } catch {
    /* the interpreter is in no state to flush; nothing more we can do */
  }
}

/**
 * Take Pyodide's own plumbing off the top of a traceback. Every error arrives with two frames
 * from `_pyodide/_base.py`, which say nothing about your program. Frames from the standard
 * library are left in place: if the error happened inside json or datetime, that matters.
 */
function trimTraceback(text) {
  const lines = String(text).split('\n');
  const out = [];
  let dropping = false;
  for (const line of lines) {
    const frame = /^\s+File "([^"]*)"/.exec(line);
    if (frame) dropping = frame[1].includes('/_pyodide/');
    else if (!/^\s/.test(line)) dropping = false;   // the final "SomeError: ..." line
    if (!dropping) out.push(line);
  }
  return out.join('\n');
}

/** Python names the code it was handed `<exec>`; your file's real name is more use. */
function readableTraceback(message, entryName) {
  return trimTraceback(String(message).split('"<exec>"').join(`"${entryName}"`)).replace(/\n+$/, '');
}

/** `sys.exit(2)` is not a crash — it is a program choosing its own exit code. */
function exitCodeFrom(message) {
  const match = /SystemExit:\s*(-?\d+)/.exec(String(message));
  return match ? Number(match[1]) : 0;
}

/* ---------- Running ---------- */

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type !== 'run') return;

  try {
    await boot(message.base);
  } catch (err) {
    // Usually no internet. The other possibility is that the version in config.js has been
    // withdrawn from the CDN, which reads as the same failure, so name both.
    send({
      type: 'failed',
      message: `Python could not be started from ${message.base}\n`
        + `${err?.message || err}\n`
        + 'Check your internet connection. If it is fine, the version may have moved on: '
        + 'change pyodideVersion in js/config.js to a version that exists.',
    });
    return;
  }
  send({ type: 'ready', version: pythonVersion || pyodide.version });

  const entry = message.files.find((f) => f.name === message.entryName) || message.files[0];
  let namespace = null;
  try {
    writeFiles(message.files);
    pyodide.globals.set('_svs_stdin', message.stdin || '');
    pyodide.runPython(PRELUDE);

    // A fresh set of variables for every run, so nothing survives from the last one.
    namespace = pyodide.runPython('dict()');
    namespace.set('__name__', '__main__');
    namespace.set('__file__', `${DIR}/${entry.name}`);

    await pyodide.runPythonAsync(entry.content, { globals: namespace, filename: entry.name });
    flush();
    send({ type: 'done', code: 0 });
  } catch (err) {
    flush();   // whatever the program managed to print belongs above its traceback
    const text = err?.message || String(err);
    if (err?.type === 'SystemExit') {
      send({ type: 'done', code: exitCodeFrom(text) });
      return;
    }
    write(`${readableTraceback(text, entry.name)}\n`, 'stderr');
    send({ type: 'done', code: 1 });
  } finally {
    try {
      namespace?.destroy();
    } catch {
      /* already gone */
    }
  }
};

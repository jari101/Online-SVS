/* tests/fixtures/pyodide/pyodide.mjs — a stand-in for Pyodide, used by the smoke test only.
 *
 * The real Pyodide is a 12 MB download of CPython compiled to WebAssembly, and the test
 * sandbox has no internet access. This file answers the same small set of calls that
 * js/runners/python.worker.js makes, so the test can check the plumbing around Python —
 * that output reaches the Output tab, that the Input tab arrives as stdin, that a companion
 * file is written where an import can find it, and that a traceback and an exit code come
 * back — without an interpreter being involved.
 *
 * It understands only the handful of Python lines the test writes, listed in `execute` below.
 * It is not an interpreter and is never shipped: production loads the real Pyodide from the
 * address in CONFIG.pyodideBase.
 */

const encoder = new TextEncoder();

/** Mimics Pyodide's error object closely enough for the worker to tell SystemExit apart. */
class PythonError extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'PythonError';
    this.type = type;
  }
}

export async function loadPyodide() {
  const fs = new Map();            // path -> text, standing in for Python's file system
  const globals = new Map();
  let stdinLines = [];
  let stdinAt = 0;
  let stdout = () => {};
  let stderr = () => {};

  const sink = (options) => {
    if (options.write) return (text) => options.write(encoder.encode(text));
    return (text) => options.batched(text.replace(/\n$/, ''));
  };

  const readLine = () => (stdinAt < stdinLines.length ? stdinLines[stdinAt++] : null);

  /** The pieces of Python the test actually writes. Anything else is a NameError. */
  function execute(source, entry) {
    const names = new Map();
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      let match = /^from\s+(\w+)\s+import\s+(\w+)$/.exec(line);
      if (match) {
        const module = fs.get(`/svs/${match[1]}.py`);
        if (module === undefined) {
          throw new PythonError('ModuleNotFoundError', `Traceback (most recent call last):\n  File "${entry}", line ${i + 1}, in <module>\nModuleNotFoundError: No module named '${match[1]}'`);
        }
        const assigned = new RegExp(`^${match[2]}\\s*=\\s*["'](.*)["']$`, 'm').exec(module);
        names.set(match[2], assigned ? assigned[1] : '');
        continue;
      }

      match = /^import\s+\w+$/.exec(line);
      if (match) continue;

      match = /^(\w+)\s*=\s*input\(\)$/.exec(line);
      if (match) {
        const value = readLine();
        if (value === null) throw new PythonError('EOFError', `Traceback (most recent call last):\n  File "${entry}", line ${i + 1}, in <module>\nEOFError: EOF when reading a line`);
        names.set(match[1], value);
        continue;
      }

      match = /^print\((?:"([^"]*)"|'([^']*)')\)$/.exec(line);
      if (match) {
        stdout(`${match[1] ?? match[2]}\n`);
        continue;
      }

      if (line === 'print(input())') {
        const value = readLine();
        if (value === null) throw new PythonError('EOFError', `Traceback (most recent call last):\n  File "${entry}", line ${i + 1}, in <module>\nEOFError: EOF when reading a line`);
        stdout(`${value}\n`);
        continue;
      }

      match = /^print\((\w+)\)$/.exec(line);
      if (match && names.has(match[1])) {
        stdout(`${names.get(match[1])}\n`);
        continue;
      }

      match = /^sys\.exit\((-?\d+)\)$/.exec(line);
      if (match) throw new PythonError('SystemExit', `SystemExit: ${match[1]}`);

      throw new PythonError(
        'NameError',
        `Traceback (most recent call last):\n  File "${entry}", line ${i + 1}, in <module>\nNameError: name '${line.split(/\W/)[0]}' is not defined`,
      );
    }
  }

  return {
    version: '3.14.0-test',
    globals: { set: (key, value) => globals.set(key, value) },
    setStdout: (options) => { stdout = sink(options); },
    setStderr: (options) => { stderr = sink(options); },
    FS: {
      readdir: (dir) => ['.', '..', ...[...fs.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1))],
      unlink: (path) => fs.delete(path),
      writeFile: (path, content) => fs.set(path, content),
    },
    runPython: (code) => {
      if (code.trim() === 'dict()') {
        const namespace = new Map();
        namespace.destroy = () => namespace.clear();
        return namespace;
      }
      if (code.includes('io.StringIO(_svs_stdin)')) {
        const text = globals.get('_svs_stdin') || '';
        stdinLines = text ? text.replace(/\n$/, '').split('\n') : [];
        stdinAt = 0;
      }
      return undefined;          // the os/sys set-up needs no answer
    },
    runPythonAsync: async (source, options = {}) => {
      const entry = options.globals?.get?.('__file__')?.split('/').pop() || '<exec>';
      execute(source, entry);
      void stderr;
    },
  };
}

// js/runners/browser.js — the runtimes that live inside this tab.
//
// JavaScript and TypeScript run in a Web Worker straight away; TypeScript is compiled to
// JavaScript first by the very same compiler Monaco already uses to underline your mistakes,
// so it costs no extra download. Python runs on Pyodide, which is CPython compiled to
// WebAssembly and fetched once.
//
// Nothing here sends your code anywhere. It also means Stop really stops: terminating a
// worker kills an endless loop, which no amount of waiting on a server ever could.

import { CONFIG } from '../config.js';
import { getMonaco } from '../editor.js';

/** Thrown when a run is abandoned, so the caller can tell it apart from a crash. */
const abortError = () => new DOMException('The run was stopped.', 'AbortError');

let pythonWorker = null;   // kept alive between runs: booting Python again costs seconds
let pythonVersion = null;

/** The name to show in the Output tab for where the program ran. */
export function browserEngine(lang) {
  if (lang.browser === 'python') return pythonVersion ? `Python ${pythonVersion}` : 'Python';
  if (lang.browser === 'typescript') return 'TypeScript, compiled to JavaScript';
  return 'JavaScript';
}

/** Let go of the Python interpreter, so the next run starts a fresh one. */
export function resetPython() {
  pythonWorker?.terminate();
  pythonWorker = null;
}

/* ---------- Talking to a worker ---------- */

/**
 * Send one program to `worker` and collect what it prints until it says it is done.
 * `onTerminate` runs if the worker had to be killed, so a cached one is not reused after.
 */
function drive(worker, message, { onOutput, onStatus, onEngine, signal, onTerminate }) {
  return new Promise((resolve, reject) => {
    const stop = () => {
      worker.onmessage = null;
      worker.onerror = null;
      signal?.removeEventListener('abort', abandon);
    };

    function abandon() {
      stop();
      worker.terminate();
      onTerminate?.();
      reject(abortError());
    }

    function fail(message) {
      stop();
      worker.terminate();
      onTerminate?.();
      reject(new Error(message));
    }

    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'output') onOutput(data.text, data.stream);
      else if (data.type === 'status') onStatus?.(data.text);
      else if (data.type === 'ready') {
        if (data.version) pythonVersion = data.version;
        onStatus?.(''); // the interpreter is up: the clock for a slow download can stop
        onEngine?.(data.version ? `Python ${data.version}` : 'Python');
      } else if (data.type === 'failed') fail(data.message);
      else if (data.type === 'done') {
        stop();
        resolve({ code: data.code });
      }
    };
    worker.onerror = (event) => fail(event.message || 'The program could not be started.');

    if (signal?.aborted) return abandon();
    signal?.addEventListener('abort', abandon);
    worker.postMessage(message);
    return undefined;
  });
}

/* ---------- TypeScript ---------- */

/**
 * Compile the TypeScript files to JavaScript with Monaco's own TypeScript service.
 * Type errors do not stop the compile — they are already underlined in the editor and shown
 * in the Problems tab, and `tsc` itself emits JavaScript for a file that has them.
 */
async function compileTypeScript(files) {
  const monaco = getMonaco();
  if (!monaco) throw new Error('The editor is still loading, so TypeScript cannot be compiled yet.');

  const ts = monaco.languages.typescript;
  // Merge rather than replace: whatever the editor was already told to assume stays true.
  ts.typescriptDefaults.setCompilerOptions({
    ...ts.typescriptDefaults.getCompilerOptions(),
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    allowNonTsExtensions: true,
  });

  const getWorker = await ts.getTypeScriptWorker();
  const models = [];
  try {
    // Every file needs a model for the compiler to see it, including the companions.
    for (const file of files) {
      const uri = monaco.Uri.parse(`inmemory://svs-run/${file.name}`);
      const existing = monaco.editor.getModel(uri);
      if (existing) existing.setValue(file.content);
      else models.push(monaco.editor.createModel(file.content, 'typescript', uri));
    }

    const compiled = [];
    for (const file of files) {
      const uri = monaco.Uri.parse(`inmemory://svs-run/${file.name}`);
      const client = await getWorker(uri);
      const emitted = await client.getEmitOutput(uri.toString());
      const js = emitted.outputFiles.find((f) => f.name.endsWith('.js'));
      if (!js) throw new Error(`TypeScript produced no JavaScript for "${file.name}".`);
      compiled.push({ name: file.name.replace(/\.tsx?$/, '.js'), content: js.text });
    }
    return compiled;
  } finally {
    for (const model of models) model.dispose();
  }
}

/* ---------- Running ---------- */

/**
 * Run a program here in the browser.
 * Returns { code } — the exit code the program finished with.
 */
export async function runInBrowser({ lang, files, entryName, stdin, onOutput, onStatus, onEngine, signal }) {
  if (lang.browser === 'python') {
    if (!pythonWorker) {
      pythonWorker = new Worker(new URL('./python.worker.js', import.meta.url), { type: 'module' });
    }
    return drive(
      pythonWorker,
      { type: 'run', files, entryName, stdin, base: CONFIG.pyodideBase },
      { onOutput, onStatus, onEngine, signal, onTerminate: () => { pythonWorker = null; } },
    );
  }

  let program = files;
  let entry = entryName;
  if (lang.browser === 'typescript') {
    program = await compileTypeScript(files);
    entry = entryName.replace(/\.tsx?$/, '.js');
  }
  // Nothing has to be downloaded or booted here, so the engine is known before we start.
  onEngine?.(browserEngine(lang));

  // JavaScript workers are cheap to start, so each run gets a clean one.
  const worker = new Worker(new URL('./js.worker.js', import.meta.url), { type: 'module' });
  try {
    return await drive(worker, { type: 'run', files: program, entryName: entry, stdin }, { onOutput, onStatus, signal });
  } finally {
    worker.terminate();
  }
}

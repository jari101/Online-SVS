// js/languages.js — the languages you can write and run, with the file extension Monaco needs
// for syntax colouring, how each one is run and a starter program.
//
// A language can be run in two places. `browser` names a runtime that lives inside this tab,
// so the code never leaves your machine and works with no internet once it is cached.
// `piston` names the language on a Piston server, used for everything a browser cannot
// compile by itself (C, C++, Java, C#, Go, Rust…). A language may have both: the browser
// wins, because it is faster, private and always available.
//
// `companions` lists the extensions of other files in the same folder that are sent along with
// the file you run, so `#include "utils.h"` or `import helper` finds them.
//
// Data files such as .json are deliberately not companions: they are where configuration and
// keys tend to live, and uploading them because they happen to sit beside your code would be a
// surprise. Add one by opening it and running from there if you really need it.
//
// `entryPoint` marks the languages where sending a second file that also has a main function
// breaks the build. A folder of exercises, each with its own main, is the common case, so those
// neighbours are left out and only genuine helpers and headers travel with your file.

import { extOf, parentOf } from './fs/util.js';

export const LANGUAGES = [
  {
    id: 'c', name: 'C', ext: 'c', monaco: 'c', piston: 'c',
    companions: ['c', 'h'],
    entryPoint: /\b(?:int|void)\s+main\s*\(/,
    template: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello, World!\\n");\n    return 0;\n}\n',
  },
  {
    id: 'cpp', name: 'C++', ext: 'cpp', monaco: 'cpp', piston: 'c++',
    companions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'h'],
    entryPoint: /\b(?:int|void)\s+main\s*\(/,
    template: '#include <iostream>\n\nint main() {\n    std::cout << "Hello, World!" << std::endl;\n    return 0;\n}\n',
  },
  {
    id: 'python', name: 'Python', ext: 'py', monaco: 'python', piston: 'python', browser: 'python',
    companions: ['py'],
    template: 'print("Hello, World!")\n',
  },
  {
    id: 'javascript', name: 'JavaScript', ext: 'js', monaco: 'javascript', piston: 'javascript', browser: 'javascript',
    companions: ['js', 'mjs', 'cjs'],
    template: 'console.log("Hello, World!");\n',
  },
  {
    id: 'typescript', name: 'TypeScript', ext: 'ts', monaco: 'typescript', piston: 'typescript', browser: 'typescript',
    companions: ['ts'],
    template: 'const message: string = "Hello, World!";\nconsole.log(message);\n',
  },
  {
    id: 'java', name: 'Java', ext: 'java', monaco: 'java', piston: 'java',
    companions: ['java'],
    template: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}\n',
  },
  {
    id: 'csharp', name: 'C#', ext: 'cs', monaco: 'csharp', piston: 'csharp',
    companions: ['cs'],
    entryPoint: /\bstatic\s+[\w<>\[\],.\s]*\bMain\s*\(/,
    template: 'using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello, World!");\n    }\n}\n',
  },
  {
    id: 'go', name: 'Go', ext: 'go', monaco: 'go', piston: 'go',
    companions: ['go'],
    entryPoint: /\bfunc\s+main\s*\(/,
    template: 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, World!")\n}\n',
  },
  {
    id: 'rust', name: 'Rust', ext: 'rs', monaco: 'rust', piston: 'rust',
    companions: [],
    template: 'fn main() {\n    println!("Hello, World!");\n}\n',
  },
  {
    id: 'php', name: 'PHP', ext: 'php', monaco: 'php', piston: 'php',
    companions: ['php'],
    template: '<?php\necho "Hello, World!\\n";\n',
  },
  {
    id: 'ruby', name: 'Ruby', ext: 'rb', monaco: 'ruby', piston: 'ruby',
    companions: ['rb'],
    template: 'puts "Hello, World!"\n',
  },
  {
    id: 'kotlin', name: 'Kotlin', ext: 'kt', monaco: 'kotlin', piston: 'kotlin',
    companions: ['kt'],
    template: 'fun main() {\n    println("Hello, World!")\n}\n',
  },
  {
    id: 'swift', name: 'Swift', ext: 'swift', monaco: 'swift', piston: 'swift',
    companions: ['swift'],
    template: 'print("Hello, World!")\n',
  },
  {
    id: 'bash', name: 'Bash', ext: 'sh', monaco: 'shell', piston: 'bash',
    companions: ['sh'],
    template: 'echo "Hello, World!"\n',
  },
  {
    id: 'lua', name: 'Lua', ext: 'lua', monaco: 'lua', piston: 'lua',
    companions: ['lua'],
    template: 'print("Hello, World!")\n',
  },
  {
    id: 'html', name: 'HTML (live preview)', ext: 'html', monaco: 'html', piston: null,
    companions: [],
    template: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>My page</title>\n  <style>\n    body { font-family: sans-serif; padding: 2rem; }\n  </style>\n</head>\n<body>\n  <h1>Hello, World!</h1>\n  <p>Press Go Live to preview this page.</p>\n</body>\n</html>\n',
  },
];

/** Extra extensions that map onto one of the languages above (used for files in a folder). */
const EXTRA_EXTENSIONS = {
  cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', h: 'c',
  mjs: 'javascript', cjs: 'javascript',
  htm: 'html',
};

export function findLanguage(id) {
  return LANGUAGES.find((l) => l.id === id) || null;
}

/** The language a file belongs to, judged by its extension, or null if unknown. */
export function languageForPath(path) {
  const ext = extOf(path);
  if (!ext) return null;
  const direct = LANGUAGES.find((l) => l.ext === ext);
  if (direct) return direct;
  const mapped = EXTRA_EXTENSIONS[ext];
  return mapped ? findLanguage(mapped) : null;
}

/** True when this language can be run at all, here or on a server (HTML is previewed, not run). */
export function isRunnable(lang) {
  return Boolean(lang && (lang.browser || lang.piston));
}

/** True when this language has a runtime that works inside the browser, with no server. */
export function runsInBrowser(lang) {
  return Boolean(lang && lang.browser);
}

/** True when this language can only be run by a Piston server you point the app at. */
export function needsServer(lang) {
  return Boolean(lang && lang.piston && !lang.browser);
}

/**
 * The file name a piece of source code should be given when it is run.
 * Java is the fussy one: the file must be named after its public class, or javac refuses
 * to compile it, so we read the class name out of the source.
 */
export function entryFileName(lang, source, fallbackName = null) {
  if (lang.id === 'java') {
    const match = /(?:^|\n)\s*public\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(source);
    return `${match ? match[1] : 'Main'}.java`;
  }
  return fallbackName || `main.${lang.ext}`;
}

/** True when this source would give the compiler a second program entry point. */
export function definesEntryPoint(lang, source) {
  return Boolean(lang.entryPoint && lang.entryPoint.test(source));
}

/** Paths in the same folder as `path` that belong to the same language family. */
export function companionPaths(tree, path, lang) {
  if (!tree || !lang.companions.length) return [];
  const dir = parentOf(path);
  const node = findDir(tree, dir);
  if (!node) return [];
  return node.children
    .filter((child) => child.kind === 'file'
      && child.path !== path
      && lang.companions.includes(extOf(child.name)))
    .map((child) => child.path);
}

function findDir(node, dir) {
  if (node.kind !== 'dir') return null;
  if (node.path === dir) return node;
  for (const child of node.children) {
    const hit = findDir(child, dir);
    if (hit) return hit;
  }
  return null;
}

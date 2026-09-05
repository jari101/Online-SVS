// js/languages.js — the languages the scratch editor offers, with the file extension Monaco
// needs for syntax colouring, the name Piston uses to run them (Phase 3) and a starter program.

import { extOf } from './fs/util.js';

export const LANGUAGES = [
  {
    id: 'c', name: 'C', ext: 'c', monaco: 'c', piston: 'c',
    template: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello, World!\\n");\n    return 0;\n}\n',
  },
  {
    id: 'cpp', name: 'C++', ext: 'cpp', monaco: 'cpp', piston: 'c++',
    template: '#include <iostream>\n\nint main() {\n    std::cout << "Hello, World!" << std::endl;\n    return 0;\n}\n',
  },
  {
    id: 'python', name: 'Python', ext: 'py', monaco: 'python', piston: 'python',
    template: 'print("Hello, World!")\n',
  },
  {
    id: 'javascript', name: 'JavaScript', ext: 'js', monaco: 'javascript', piston: 'javascript',
    template: 'console.log("Hello, World!");\n',
  },
  {
    id: 'typescript', name: 'TypeScript', ext: 'ts', monaco: 'typescript', piston: 'typescript',
    template: 'const message: string = "Hello, World!";\nconsole.log(message);\n',
  },
  {
    id: 'java', name: 'Java', ext: 'java', monaco: 'java', piston: 'java',
    template: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}\n',
  },
  {
    id: 'csharp', name: 'C#', ext: 'cs', monaco: 'csharp', piston: 'csharp',
    template: 'using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello, World!");\n    }\n}\n',
  },
  {
    id: 'go', name: 'Go', ext: 'go', monaco: 'go', piston: 'go',
    template: 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, World!")\n}\n',
  },
  {
    id: 'rust', name: 'Rust', ext: 'rs', monaco: 'rust', piston: 'rust',
    template: 'fn main() {\n    println!("Hello, World!");\n}\n',
  },
  {
    id: 'php', name: 'PHP', ext: 'php', monaco: 'php', piston: 'php',
    template: '<?php\necho "Hello, World!\\n";\n',
  },
  {
    id: 'ruby', name: 'Ruby', ext: 'rb', monaco: 'ruby', piston: 'ruby',
    template: 'puts "Hello, World!"\n',
  },
  {
    id: 'kotlin', name: 'Kotlin', ext: 'kt', monaco: 'kotlin', piston: 'kotlin',
    template: 'fun main() {\n    println("Hello, World!")\n}\n',
  },
  {
    id: 'swift', name: 'Swift', ext: 'swift', monaco: 'swift', piston: 'swift',
    template: 'print("Hello, World!")\n',
  },
  {
    id: 'bash', name: 'Bash', ext: 'sh', monaco: 'shell', piston: 'bash',
    template: 'echo "Hello, World!"\n',
  },
  {
    id: 'lua', name: 'Lua', ext: 'lua', monaco: 'lua', piston: 'lua',
    template: 'print("Hello, World!")\n',
  },
  {
    id: 'html', name: 'HTML (live preview)', ext: 'html', monaco: 'html', piston: null,
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

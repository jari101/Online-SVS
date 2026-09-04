// js/fs/sample.js — a small website that ships with Online SVS so you can try the editor
// (and, from Phase 2 on, the live server) without opening a folder of your own.

export const SAMPLE_NAME = 'sample-site';

export const SAMPLE_FILES = {
  'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sample Site</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <header class="site-header">
    <img src="img/logo.svg" alt="Sample logo" class="logo">
    <nav>
      <a href="index.html" class="active">Home</a>
      <a href="about.html">About</a>
    </nav>
  </header>

  <main>
    <h1>Hello from the sample site 👋</h1>
    <p>
      Edit any file in the Explorer on the left. When you press <strong>Go Live</strong>,
      this page updates as you type (as long as your code has no errors).
    </p>
    <button id="counter">Clicked 0 times</button>
    <p id="clock" class="clock"></p>
  </main>

  <script src="js/app.js"></script>
</body>
</html>
`,

  'about.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>About – Sample Site</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <header class="site-header">
    <img src="img/logo.svg" alt="Sample logo" class="logo">
    <nav>
      <a href="index.html">Home</a>
      <a href="about.html" class="active">About</a>
    </nav>
  </header>

  <main>
    <h1>About this site</h1>
    <p>This is a second page, so you can see that links between pages work in the live preview.</p>
    <ul>
      <li><code>css/style.css</code> holds the colours and layout.</li>
      <li><code>js/app.js</code> makes the button and the clock work.</li>
      <li><code>img/logo.svg</code> is the logo in the header.</li>
    </ul>
  </main>

  <script src="js/app.js"></script>
</body>
</html>
`,

  'css/style.css': `:root {
  --bg: #f5f7fb;
  --card: #ffffff;
  --text: #1f2933;
  --muted: #52606d;
  --accent: #2563eb;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
}

.site-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  background: var(--card);
  border-bottom: 1px solid #e3e8ef;
}

.logo { width: 36px; height: 36px; }

nav a {
  margin-right: 14px;
  color: var(--muted);
  text-decoration: none;
  font-weight: 500;
}
nav a.active, nav a:hover { color: var(--accent); }

main {
  max-width: 640px;
  margin: 48px auto;
  padding: 32px;
  background: var(--card);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(31, 41, 51, 0.08);
}

h1 { margin-top: 0; }

button {
  padding: 10px 18px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 15px;
  cursor: pointer;
}
button:hover { filter: brightness(1.1); }

.clock { color: var(--muted); font-variant-numeric: tabular-nums; }
`,

  'js/app.js': `// A tiny script so you can see JavaScript running in the live preview.

const button = document.getElementById('counter');
let clicks = 0;

if (button) {
  button.addEventListener('click', () => {
    clicks += 1;
    button.textContent = \`Clicked \${clicks} time\${clicks === 1 ? '' : 's'}\`;
  });
}

const clock = document.getElementById('clock');

function tick() {
  if (clock) clock.textContent = 'The time is ' + new Date().toLocaleTimeString();
}

tick();
setInterval(tick, 1000);
`,

  'img/logo.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#2563eb"/>
  <path d="M22 18 10 32l12 14M42 18l12 14-12 14M36 12 28 52" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`,

  'README.md': `# Sample site

A two-page website used to try out Online SVS.

- Open \`index.html\` and change the heading.
- Press **Go Live** (Phase 2) to see the change in the preview panel.
- This folder lives only in your browser's memory: refresh the page and it is reset.
`,
};

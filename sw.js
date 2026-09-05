/* sw.js — the Live Server of Online SVS.
 *
 * A Service Worker is a small script the browser runs in the background. It can answer
 * network requests itself. We use that to act as a web server for the folder you are
 * editing: js/live.js stores every file in the browser's Cache API under
 *     <site>/live/<path>
 * and this worker answers any request for such an address from that cache.
 * Requests for anything else (the IDE itself, the CDN) are left alone.
 *
 * Nothing here talks to a server: the cache lives in your browser and is cleared when the
 * live server stops.
 */

const CACHE_NAME = 'svs-live-v1';
const LIVE_PREFIX = new URL('live/', self.registration.scope).pathname; // e.g. "/Online-SVS/live/"

// This tiny script is added to every HTML page we serve. It listens for messages from the
// IDE and reloads the page (or just swaps a stylesheet) when you change a file.
const LIVE_SCRIPT = `
<script data-svs-live>
(() => {
  if (!('BroadcastChannel' in self)) return;
  const channel = new BroadcastChannel('svs-live');
  channel.onmessage = (event) => {
    const message = event.data || {};
    if (message.type === 'reload') {
      location.reload();
    } else if (message.type === 'css') {
      let swapped = false;
      for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
        const url = new URL(link.getAttribute('href'), location.href);
        if (url.origin === location.origin && url.pathname === message.path) {
          url.searchParams.set('svs', Date.now().toString(36));
          link.href = url.href;
          swapped = true;
        }
      }
      if (!swapped) location.reload();
    }
  };
})();
</script>`;

self.addEventListener('install', () => {
  self.skipWaiting(); // a new version of this file takes over immediately
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(LIVE_PREFIX)) {
    return; // not a live-server address: let the browser fetch it normally
  }
  event.respondWith(serve(url, event.request));
});

async function serve(url, request) {
  const cache = await caches.open(CACHE_NAME);
  const path = url.pathname;

  // "/live/" and "/live/docs/" mean index.html; "/live/about" may mean about.html.
  const candidates = [];
  if (path.endsWith('/')) {
    candidates.push(path + 'index.html');
  } else {
    candidates.push(path);
    const lastSegment = path.slice(path.lastIndexOf('/') + 1);
    if (!lastSegment.includes('.')) candidates.push(path + '.html', path + '/index.html');
  }

  for (const candidate of candidates) {
    const hit = await cache.match(new URL(candidate, url.origin).href, { ignoreSearch: true });
    if (hit) return decorate(hit, request);
  }
  return notFound(path);
}

/** Add the live-reload script to HTML pages; pass everything else through untouched. */
async function decorate(response, request) {
  const type = response.headers.get('Content-Type') || '';
  if (!type.startsWith('text/html') || request.mode !== 'navigate') {
    return response;
  }
  const html = await response.text();
  const injected = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${LIVE_SCRIPT}</body>`) : html + LIVE_SCRIPT;
  return new Response(injected, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function notFound(path) {
  const safePath = path.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 – Not found</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #1e1e1e; color: #cccccc; }
    main { max-width: 32rem; padding: 2rem; text-align: center; }
    h1 { font-weight: 500; color: #ffffff; }
    code { padding: 0.1em 0.4em; border-radius: 4px; background: #333333; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>404 – Not found</h1>
    <p>The live server has no file at <code>${safePath}</code>.</p>
    <p>Check that the live server is running in Online SVS and that the file exists in your folder. This page reloads by itself once the file is available.</p>
  </main>
  ${LIVE_SCRIPT}
</body>
</html>`;
  return new Response(html, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

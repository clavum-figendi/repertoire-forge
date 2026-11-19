const BASE = new URL('./', self.location.href);
const PREFIX = `repertoire-forge:${BASE.pathname}:`;
const CACHE = `${PREFIX}4`;
const localURL = path => new URL(path, BASE).href;
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(['./','index.html','manifest.webmanifest','credits.html','engine/stockfish-17.1-lite-single-03e3232.js','engine/stockfish-17.1-lite-single-03e3232.wasm','vendor/sql-wasm.wasm'].map(localURL));
    // Read Vite's built entry points from production HTML; never assume hashed filenames.
    const html = await (await cache.match(localURL('index.html'))).text();
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)].map(m => new URL(m[1], BASE).href);
    await cache.addAll(assets);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => { for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key); await self.clients.claim(); })());
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_ASSETS' || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.map(url => new URL(url, BASE)).filter(url => url.origin === BASE.origin && url.pathname.startsWith(BASE.pathname)).map(url => url.href);
  event.waitUntil((async () => { const cache = await caches.open(CACHE); const failed=[];for (const url of urls) { try { const response = await fetch(url); if (!response.ok) throw new Error(`HTTP ${response.status}`);await cache.put(url, response); } catch { if(!await cache.match(url))failed.push(url); } }event.source?.postMessage({type:'CACHE_STATUS',failed}); })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try { const response = await fetch(event.request); if (response.ok) await cache.put(event.request, response.clone()); return response; }
    catch (error) { if (event.request.mode === 'navigate') { const fallback = await cache.match(localURL('index.html')); if (fallback) return fallback; } throw error; }
  })());
});

const CACHE = 'garde-multi-v167';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=138',
  './doctors.js?v=44',
  './xlsx.js?v=1',
  './app.js?v=117',
  './auth.js?v=44',
  './supabase-config.js?v=42',
  './manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Ne jamais cacher les requêtes vers Supabase
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.com')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // HTML / navigation : NETWORK-FIRST — le index.html n'est pas versionné par ?v=,
  // donc on veut toujours la dernière version quand on est en ligne (les changements
  // de page apparaissent tout de suite). Repli sur le cache hors ligne.
  const isHTML = e.request.mode === 'navigate' ||
                 url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  if (isHTML) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
    return;
  }
  // Le reste (JS/CSS versionnés par ?v=, images…) : cache-first.
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

const CACHE = 'garde-multi-v55';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=82',
  './doctors.js?v=82',
  './app.js?v=82',
  './auth.js?v=82',
  './supabase-config.js?v=82',
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
  // Ne jamais cacher les requêtes vers Supabase
  const url = new URL(e.request.url);
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.com')) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

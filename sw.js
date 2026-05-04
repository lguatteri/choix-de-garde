const CACHE = 'garde-multi-v8';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=34',
  './doctors.js?v=34',
  './app.js?v=34',
  './auth.js?v=34',
  './supabase-config.js?v=34',
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

const CACHE = 'garde-multi-v47';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=74',
  './doctors.js?v=74',
  './app.js?v=74',
  './auth.js?v=74',
  './supabase-config.js?v=74',
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

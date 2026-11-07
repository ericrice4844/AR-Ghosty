// Offline cache for the app shell. CDN models (object detection) are cached on use.
const CACHE = 'ghosty-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'assets/icon.svg',
  'js/main.js', 'js/hunt.js', 'js/ghosts.js', 'js/render.js', 'js/audio.js', 'js/sensors.js',
  'js/voice.js', 'js/detect.js', 'js/storage.js', 'js/world.js', 'js/util.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Network first so updates land; fall back to cache when offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.url.startsWith(self.location.origin) || req.url.includes('cdn.jsdelivr.net') || req.url.includes('storage.googleapis.com'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});

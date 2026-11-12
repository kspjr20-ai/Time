// Cache para uso offline dentro do shopping (sinal costuma ser ruim).
const VERSION = 'v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/graph.js', 'js/mapview.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'data/mall.json', 'maps/g1.webp', 'maps/l1.webp', 'maps/l2.webp', 'maps/l3.webp',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Rede primeiro (para pegar mapa atualizado), cache quando estiver sem sinal.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});

/* sw.js — so the page still opens when the internet does not.
 *
 * Hosting the console on Cloudflare means fetching it over the internet to
 * talk to a broker three metres away, which fails in exactly the situation
 * where you most want to look at the network. This caches the whole bundle on
 * first visit, so after that it loads with no internet at all and still
 * reaches the broker over the LAN.
 *
 * Cache-first with a background refresh: the page is a handful of small static
 * files and being one visit behind on a stylesheet has never mattered, while
 * failing to open has.
 *
 * It does not touch MQTT. A WebSocket is not a fetch, so nothing here is
 * between the console and the broker. */

var CACHE = 'nowqtt-console-v2.5';
var FILES = [
  'index.html',
  'css/app.css',
  'js/theme.js', 'js/store.js', 'js/broker.js', 'js/model.js', 'js/topo.js', 'js/antenna.js', 'js/image.js',
  'js/ota.js', 'js/config.js', 'js/netcfg.js', 'js/history.js', 'js/map.js',
  'js/map3d.js',
  'js/ui.js', 'js/views.js', 'js/network.js',
  'vendor/mqtt.min.js',
  'manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* addAll fails the whole install if any single file 404s, which would
       * leave no cache at all. Individually, a missing file costs only itself. */
      return Promise.all(FILES.map(function (f) {
        return c.add(new Request(f, { cache: 'reload' })).catch(function () { });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                             .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      var net = fetch(e.request).then(function (res) {
        if (res && res.ok) {
          caches.open(CACHE).then(function (c) { c.put(e.request, res.clone()); });
        }
        return res;
      });
      return hit || net;
    }).catch(function () { return fetch(e.request); })
  );
});

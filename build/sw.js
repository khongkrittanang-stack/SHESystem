/**
 * SHE System - Service Worker
 * Comprehensive PWA Service Worker for Offline Support & Asset Caching
 */

const CACHE_VERSION = 'she-system-v1.0.2';
const STATIC_CACHE = `she-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `she-dynamic-${CACHE_VERSION}`;
const IMMUTABLE_CACHE = `she-immutable-${CACHE_VERSION}`;

// Pre-cached core app shell assets
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/favicon.png',
  '/favicon.ico',
  '/jde_peets_badge.png',
  '/jde_peets_logo.webp',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/icon-maskable-192x192.png',
  '/icons/icon-maskable-512x512.png'
];

// Install Event: Pre-cache core shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      // Use cache.addAll with individual catch so 1 missing asset does not abort entire install
      return Promise.allSettled(
        CORE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[SW] Pre-caching asset failed: ${url}`, err);
          })
        )
      );
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Activate Event: Clean up outdated caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('she-') && name !== STATIC_CACHE && name !== DYNAMIC_CACHE && name !== IMMUTABLE_CACHE)
          .map((name) => {
            console.log(`[SW] Removing outdated cache: ${name}`);
            return caches.delete(name);
          })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Helper: Determine if URL is static asset
function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.woff') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  );
}

// Fetch Event: Intelligent multi-tier routing
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. Only handle GET requests for caching
  if (request.method !== 'GET') {
    return;
  }

  // 2. Chrome Extension or external protocols - bypass
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // 3. API Endpoints: Network-first with offline fallback JSON
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .catch(() => {
          return new Response(
            JSON.stringify({
              offline: true,
              error: 'Offline',
              message: 'ขณะนี้คุณกำลังใช้งานในโหมดออฟไลน์ การบันทึกหรือดึงข้อมูลล่าสุดจะทำงานเมื่อต่ออินเทอร์เน็ต'
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }
          );
        })
    );
    return;
  }

  // 4. Navigation Requests (HTML / Page Routes): Network-First, fallback to cached index.html, then offline.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          // Fallback to cached index.html (SPA handles routing via client-side code and localStorage)
          const cachedIndex = await caches.match('/index.html');
          if (cachedIndex) {
            return cachedIndex;
          }
          const cachedOffline = await caches.match('/offline.html');
          if (cachedOffline) {
            return cachedOffline;
          }
          return new Response('Offline - Please reconnect to the internet', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // 5. Static Assets (/assets/*, fonts, icons, images): Cache-first with network background fetch
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          // Asset found in cache, return immediately
          return cachedResponse;
        }

        // Not in cache, fetch from network and store in dynamic cache
        return fetch(request)
          .then((networkResponse) => {
            if (!networkResponse || networkResponse.status !== 200) {
              return networkResponse;
            }
            const responseClone = networkResponse.clone();
            caches.open(DYNAMIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
            return networkResponse;
          })
          .catch(() => {
            // If image fails, could return placeholder or undefined
            return new Response('', { status: 408, headers: { 'Content-Type': 'text/plain' } });
          });
      })
    );
    return;
  }

  // 6. Default Fallback: Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(DYNAMIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

// Listen for message from frontend clients (e.g. skipWaiting on update)
self.addEventListener('message', (event) => {
  if (event.data && (event.data.type === 'SKIP_WAITING' || event.data.action === 'skipWaiting')) {
    self.skipWaiting();
  }
});

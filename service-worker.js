// ============================================================
// service-worker.js — Dok(s)link (/link/ repo)
// - Caches page shell + links.json
// - Polls links.json every 60 minutes for new entries
// - Shows notification when new links are detected
// ============================================================

const CACHE_VERSION = 'dokslink-v1';
const CACHE_NAME    = CACHE_VERSION + '-static';

const STATIC_FILES = [
  '/link/',
  '/link/index.html',
  '/link/links.json',
  '/link/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

const LINKS_JSON_URL  = '/link/links.json';
const CHECK_INTERVAL  = 60 * 60 * 1000; // 60 minutes in ms
const DB_NAME         = 'dokslink-db';
const DB_VERSION      = 1;
const STORE_NAME      = 'snapshots';
const SNAPSHOT_KEY    = 'links-snapshot';

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('dokslink-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => {
      self.clients.claim();
      // Start the polling loop after activation
      scheduleCheck();
    })
  );
});

// ── Fetch: network-first for JSON, cache-first for rest ──────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.includes('links.json')) {
    event.respondWith(networkFirstWithCache(event.request));
  } else {
    event.respondWith(cacheFirst(event.request));
  }
});

async function networkFirstWithCache(request) {
  try {
    const res = await fetch(request.url + '?t=' + Date.now());
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    return caches.match(request) || new Response('[]', {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// ── Notification tap → open /link/ ───────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/link/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('/link/')) return client.focus();
      }
      return clients.openWindow(target);
    })
  );
});

// ── Message from page: start polling ─────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'START_POLLING') {
    scheduleCheck();
  }
  if (event.data === 'CHECK_NOW') {
    checkForNewLinks();
  }
});

// ── Polling logic ─────────────────────────────────────────────
let checkTimer = null;

function scheduleCheck() {
  if (checkTimer) clearInterval(checkTimer);
  // Run once immediately, then every 60 min
  checkForNewLinks();
  checkTimer = setInterval(checkForNewLinks, CHECK_INTERVAL);
}

async function checkForNewLinks() {
  try {
    // Fetch fresh links.json bypassing any HTTP cache
    const res = await fetch(LINKS_JSON_URL + '?t=' + Date.now());
    if (!res.ok) return;

    const freshData = await res.json();
    if (!Array.isArray(freshData)) return;

    // Update the SW cache with the fresh version
    const cache = await caches.open(CACHE_NAME);
    cache.put(LINKS_JSON_URL, new Response(JSON.stringify(freshData), {
      headers: { 'Content-Type': 'application/json' }
    }));

    // Load the last known snapshot from IndexedDB
    const db = await openDB();
    const lastSnapshot = await getSnapshot(db);

    if (lastSnapshot === null) {
      // First run — just save the current state, no notification
      await saveSnapshot(db, freshData);
      return;
    }

    // Find IDs that are new (present in fresh but not in last snapshot)
    const lastIds = new Set(lastSnapshot.map(item => item.id));
    const newItems = freshData.filter(item => !lastIds.has(item.id));

    if (newItems.length > 0) {
      await showNewLinksNotification(newItems);
    }

    // Always update snapshot to current state
    await saveSnapshot(db, freshData);

  } catch (err) {
    console.warn('[SW] checkForNewLinks error:', err);
  }
}

async function showNewLinksNotification(newItems) {
  const count = newItems.length;
  const firstTitle = newItems[0].title || newItems[0].url;

  const title = count === 1
    ? 'Link baru di Dokslink!'
    : `${count} link baru di Dokslink!`;

  const body = count === 1
    ? firstTitle
    : `${firstTitle} dan ${count - 1} lainnya`;

  await self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'dokslink-update',   // replaces any previous unread notification
    renotify: true,
    data: { url: '/link/' },
    vibrate: [200, 100, 200]
  });
}

// ── IndexedDB helpers ─────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function getSnapshot(db) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

function saveSnapshot(db, data) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(data, SNAPSHOT_KEY);
    tx.oncomplete = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

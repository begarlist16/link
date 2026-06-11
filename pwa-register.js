// ============================================================
// pwa-register.js — Dok(s)link (/link/ repo)
// Paste this as a <script> tag inside index.html, before </body>
// ============================================================

(function () {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/link/service-worker.js', {
        scope: '/link/'
      });
      console.log('[SW] Registered, scope:', reg.scope);

      // Tell the active SW to start polling (in case it was already active)
      if (reg.active) {
        reg.active.postMessage('START_POLLING');
      }

      // Also start polling after any SW update
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'activated') {
            newWorker.postMessage('START_POLLING');
          }
        });
      });

    } catch (err) {
      console.warn('[SW] Registration failed:', err);
    }
  });

  // ── Request notification permission ──────────────────────
  // Called after a small delay to avoid an immediate permission popup on load
  async function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') return;
    if (Notification.permission === 'denied') return;

    // Wait for user to have scrolled or interacted slightly
    const permission = await Notification.requestPermission();

    if (permission === 'granted') {
      console.log('[PWA] Notification permission granted');

      // Try to register Periodic Background Sync if supported
      // (Chrome Android only — degrades gracefully if not available)
      const reg = await navigator.serviceWorker.ready;
      if ('periodicSync' in reg) {
        try {
          await reg.periodicSync.register('dokslink-check', {
            minInterval: 60 * 60 * 1000 // 60 minutes
          });
          console.log('[PWA] Periodic sync registered');
        } catch (e) {
          console.log('[PWA] Periodic sync not available, using SW interval fallback');
        }
      }
    }
  }

  // Ask for permission 4 seconds after page load (less aggressive)
  window.addEventListener('load', () => {
    setTimeout(requestNotificationPermission, 4000);
  });

})();

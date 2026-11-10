// kcoder's service worker, registered only on a phone that allowed notifications (the page served
// through the relay): shows a push as a notification and opens or focuses the app when it is tapped.
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'kcoder', { body: d.body || '', tag: d.tag || 'kcoder', data: d, icon: './icon-192.png', badge: './icon-192.png' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
    const open = all.find((c) => c.url.startsWith(self.registration.scope));
    if (open) { open.focus(); return open.navigate ? open.navigate(url) : null; }
    return clients.openWindow(url);
  }));
});
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

// Network only: private photographs and invitation URLs are never cached here.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response('<!doctype html><html lang="es"><meta name="viewport" content="width=device-width"><title>PhoTown sin conexión</title><h1>Sin conexión</h1><p>Conéctate a Internet y vuelve a abrir PhoTown.</p></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});
// Notifications: the server sends only a title, a line and a PhoTown path to open.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* unreadable payload */ }
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  event.waitUntil(self.registration.showNotification(data.title || 'PhoTown', { body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: data.tag || 'photown', data: { url } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const open = windows.find(client => client.url.startsWith(self.location.origin));
    return open ? open.navigate(url).then(client => (client || open).focus()) : self.clients.openWindow(url);
  }));
});

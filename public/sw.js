// Network only: private photographs and invitation URLs are never cached here.
// Background Sync (Chromium) sends photographs waiting in the device outbox.
importScripts('/outbox.js');
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response('<!doctype html><html lang="es"><meta name="viewport" content="width=device-width"><title>PhoTown sin conexión</title><h1>Sin conexión</h1><p>Conéctate a Internet y vuelve a abrir PhoTown. Las fotos que hayas hecho siguen guardadas en este dispositivo y se enviarán al volver la conexión.</p></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});
self.addEventListener('sync', event => {
  if (event.tag !== self.PhotownOutbox.TAG) return;
  event.waitUntil((async () => {
    const result = await self.PhotownOutbox.flush();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'outbox', result });
    // Reject to ask the browser to retry later while the network is still missing.
    if (result.offline) throw new Error('Still offline');
  })());
});

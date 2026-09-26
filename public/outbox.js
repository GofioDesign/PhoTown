// Outbox for photographs waiting to be sent. Stored in IndexedDB on this device
// so a capture survives closing the app, losing coverage or a expired session.
// Written as a classic script: the page imports it for its side effect and the
// service worker loads it with importScripts() for Background Sync (Chromium).
(function (scope) {
  const NAME = 'photown', STORE = 'outbox', TAG = 'photown-outbox';
  let opening;
  function open() {
    opening ||= new Promise((resolve, reject) => {
      const request = scope.indexedDB.open(NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { opening = null; reject(request.error); };
    });
    return opening;
  }
  async function run(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode), store = transaction.objectStore(STORE);
      let result; const request = action(store);
      if (request) request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }
  const save = item => run('readwrite', store => store.put(item));
  const remove = id => run('readwrite', store => store.delete(id));
  const list = async () => ((await run('readonly', store => store.getAll())) || []).sort((a, b) => a.created - b.created);

  // Sends the pending deliveries of one item. Idempotency keys make retries
  // safe even if a previous response was lost. Stops at network/session problems.
  async function deliver(item, summary) {
    for (const delivery of item.deliveries) {
      for (let attempt = 0; attempt < 2 && !delivery.result; attempt++) {
        const body = new FormData();
        body.append('photo', item.blob, 'photo');
        if (item.thumb) body.append('thumb', item.thumb, 'thumb');
        if (delivery.challenge) body.append('challenge', delivery.challenge);
        let response;
        try {
          response = await fetch('/api/photos', { method: 'POST', credentials: 'same-origin', headers: { 'Idempotency-Key': delivery.photoId, 'X-Photown-Group': delivery.id }, body, signal: AbortSignal.timeout(60000) });
        } catch { summary.offline = true; return false; }
        let data = {}; try { data = await response.json(); } catch { /* empty body */ }
        if (response.ok) { delivery.result = data; delete delivery.error; summary.sent++; if (data.status === 'published') summary.published++; break; }
        if (response.status === 409 && delivery.challenge && attempt === 0) { delete delivery.challenge; delivery.note = 'El reto ya estaba cerrado: se envió como foto normal.'; continue; }
        if (response.status === 401) { summary.auth = true; return false; }
        if (response.status === 429 || response.status >= 500) { summary.offline = true; return false; }
        delivery.error = data.error || 'No se pudo enviar esta fotografía.';
        summary.failed.push({ id: item.id, group: delivery.name, error: delivery.error });
        return false;
      }
    }
    return item.deliveries.every(delivery => delivery.result);
  }
  const emptySummary = () => ({ sent: 0, pending: 0, auth: false, offline: false, failed: [], published: 0 });
  let flushing = null;
  function flush() {
    flushing ||= (async () => {
      const summary = emptySummary();
      for (const item of await list()) {
        if (await deliver(item, summary)) await remove(item.id);
        else await save(item);
        if (summary.auth || summary.offline) break;
      }
      summary.pending = (await list()).length;
      return summary;
    })().finally(() => { flushing = null; });
    return flushing;
  }
  // Fallback when IndexedDB is unavailable: send from memory only.
  async function sendNow(item) { const summary = emptySummary(); summary.done = await deliver(item, summary); return summary; }
  async function requestSync() {
    try { const registration = await scope.navigator.serviceWorker?.ready; await registration?.sync?.register(TAG); } catch { /* not supported */ }
  }
  scope.PhotownOutbox = { save, remove, list, flush, sendNow, requestSync, TAG };
})(self);

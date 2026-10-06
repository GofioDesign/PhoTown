import { digest, HttpError } from './security.js';

// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291),
// written on WebCrypto so the Worker needs no extra dependency. Keys come from
// `node scripts/vapid-keys.mjs`: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, both base64url.
const encoder = new TextEncoder();
const MAX_PER_USER = 5;
// Only real push services; the endpoint is supplied by the browser, so never fetch anything else.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

export const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
async function hmac(key, data) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data));
}

// Secrets pasted as `VAPID_PUBLIC_KEY=…`, quoted or with spaces still work; anything that
// is not a valid key turns Web Push off instead of breaking the settings screen.
function cleanKey(value, name) {
  const text = String(value ?? '').trim().replace(new RegExp(`^${name}\\s*=\\s*`), '').replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : null;
}
export function vapidKeys(env) {
  const publicKey = cleanKey(env.VAPID_PUBLIC_KEY, 'VAPID_PUBLIC_KEY'), privateKey = cleanKey(env.VAPID_PRIVATE_KEY, 'VAPID_PRIVATE_KEY');
  try { if (publicKey && privateKey && unb64url(publicKey).length === 65 && unb64url(privateKey).length === 32) return { publicKey, privateKey }; } catch { /* invalid */ }
  return null;
}
export const pushReady = env => Boolean(vapidKeys(env));

async function vapidHeader(env, endpoint) {
  const keys = vapidKeys(env), publicKey = unb64url(keys.publicKey);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64url(publicKey.slice(1, 33)), y: b64url(publicKey.slice(33, 65)), d: keys.privateKey, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = value => b64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://photown.gofiodesign.eu' })}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned));
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`;
}

export async function encryptPayload(subscription, payload) {
  const uaPublic = unb64url(subscription.p256dh), authSecret = unb64url(subscription.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hmac(await hmac(authSecret, shared), concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic, [1]));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(encoder.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(encoder.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(encoder.encode(JSON.stringify(payload)), [2])));
  return concat(salt, [0, 0, 16, 0], [asPublic.length], asPublic, cipher);
}

// Sends to every device of the USER; services answering 404/410 have dropped the subscription.
export async function sendPush(env, db, userId, payload) {
  if (!pushReady(env)) return 0;
  const devices = (await db.prepare('SELECT endpoint_hash,endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=?').bind(userId).all()).results;
  let delivered = 0;
  for (const device of devices) {
    try {
      const response = await fetch(device.endpoint, {
        method: 'POST',
        headers: { Authorization: await vapidHeader(env, device.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
        body: await encryptPayload(device, payload),
        signal: AbortSignal.timeout(15000)
      });
      if (response.ok) delivered++;
      else if ([404, 410].includes(response.status)) await db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=?').bind(device.endpoint_hash).run();
      else console.error('Push rejected', response.status);
    } catch (error) { console.error('Push delivery failed', error); }
  }
  return delivered;
}

function readSubscription(body) {
  const endpoint = body?.endpoint, keys = body?.keys;
  let url;
  try { url = new URL(endpoint); } catch { throw new HttpError(400, 'La suscripción de avisos no es válida.'); }
  const validKey = (value, bytes) => { try { return typeof value === 'string' && unb64url(value).length === bytes; } catch { return false; } };
  if (endpoint.length > 1024 || url.protocol !== 'https:' || !PUSH_HOSTS.some(host => host.test(url.hostname)) || !validKey(keys?.p256dh, 65) || !validKey(keys?.auth, 16)) {
    throw new HttpError(400, 'La suscripción de avisos no es válida.');
  }
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

export async function saveSubscription(db, userId, body) {
  const subscription = readSubscription(body);
  const hash = await digest(subscription.endpoint);
  await db.prepare(`INSERT INTO push_subscriptions (endpoint_hash,user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(endpoint_hash) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,created_at=excluded.created_at`)
    .bind(hash, userId, subscription.endpoint, subscription.p256dh, subscription.auth, new Date().toISOString()).run();
  await db.prepare(`DELETE FROM push_subscriptions WHERE user_id=? AND endpoint_hash NOT IN
    (SELECT endpoint_hash FROM push_subscriptions WHERE user_id=? ORDER BY created_at DESC LIMIT ${MAX_PER_USER})`).bind(userId, userId).run();
  return { subscribed: true };
}

export async function removeSubscription(db, userId, body) {
  if (typeof body?.endpoint !== 'string' || body.endpoint.length > 1024) throw new HttpError(400, 'La suscripción de avisos no es válida.');
  await db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=? AND user_id=?').bind(await digest(body.endpoint), userId).run();
  return { subscribed: false };
}

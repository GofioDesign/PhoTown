import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/worker.js';
import { issueSession, readSession, boundedBody } from '../server/security.js';
import { sanitizeWebP } from '../server/webp.js';
import { fitDimensions, grayscale } from '../public/processing.js';

// Minimal structural fixture. Codec decoding is exercised by the browser tests.
function webp(width = 32, height = 24, metadata = false) {
  const bytes = new Uint8Array(metadata ? 42 : 30);
  bytes.set(Buffer.from('RIFF'));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(Buffer.from('WEBPVP8 '), 8);
  view.setUint32(16, 10, true);
  bytes.set([0, 0, 0, 0x9d, 1, 0x2a], 20);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  if (metadata) { bytes.set(Buffer.from('EXIF'), 30); view.setUint32(34, 4, true); bytes.set([1, 2, 3, 4], 38); }
  return bytes;
}
function environment() {
  const objects = new Map();
  return {
    INVITE_CODE: 'a-private-invitation-code-for-testing',
    SESSION_SECRET: 'a-long-session-signing-secret-for-testing-only',
    ENTRY_LIMITER: { limit: async () => ({ success: true }) },
    UPLOAD_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response('asset') },
    PHOTOS: {
      head: async key => objects.get(key) ?? null,
      put: async (key, bytes, options) => {
        assert.equal(options.onlyIf.etagDoesNotMatch, '*');
        if (objects.has(key)) return null;
        const object = { customMetadata: options.customMetadata, bytes };
        objects.set(key, object);
        return object;
      }
    },
    objects
  };
}
const origin = 'https://photown.test';
function request(path, options = {}) { return new Request(origin + path, options); }
async function cookie(env) { return (await issueSession(env, request('/'))).split(';')[0]; }
async function upload(env, id = crypto.randomUUID(), body = webp(), extra = {}) {
  return worker.fetch(request('/api/photos', { method: 'POST', headers: { Origin: origin, Cookie: await cookie(env), 'Content-Type': 'image/webp', 'Idempotency-Key': id, ...extra }, body }), env);
}
test('processing preserves aspect ratio, never upscales, converts every channel to BN', () => {
  assert.deepEqual(fitDimensions(4000, 3000), { width: 2560, height: 1920 });
  assert.deepEqual(fitDimensions(3000, 4000), { width: 1920, height: 2560 });
  assert.deepEqual(fitDimensions(640, 480), { width: 640, height: 480 });
  assert.throws(() => fitDimensions(0, 0));
  assert.deepEqual([...grayscale(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]))], [54, 54, 54, 255, 182, 182, 182, 255, 18, 18, 18, 255]);
});
test('WebP strips metadata and rejects invalid containers and excessive dimensions', () => {
  assert.deepEqual(sanitizeWebP(webp(32, 24, true)).bytes, webp());
  assert.throws(() => sanitizeWebP(new Uint8Array(100)));
  assert.throws(() => sanitizeWebP(webp(3000, 24)));
  assert.throws(() => sanitizeWebP(webp().slice(0, 29)));
  const animation = webp(); animation.set(Buffer.from('ANIM'), 12);
  assert.throws(() => sanitizeWebP(animation));
});
test('signed access cookie is private and cannot be forged, reused after secret rotation, or expired', async () => {
  const env = environment();
  const value = await issueSession(env, request('/'));
  assert.match(value, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
  assert.ok(await readSession(env, request('/', { headers: { Cookie: value } })));
  assert.equal(await readSession({ ...env, SESSION_SECRET: 'different-secret' }, request('/', { headers: { Cookie: value } })), null);
  assert.equal(await readSession(env, request('/', { headers: { Cookie: value.replace(/\.\d{10}\./, '.1000000000.') } })), null);
  assert.equal(await readSession(env, request('/', { headers: { Cookie: value.replace('photown_access=', 'photown_access=bad') } })), null);
});
test('entry validates invitation, origin, rate limit and fails closed without secrets', async () => {
  const env = environment();
  const enter = (body, headers = {}) => worker.fetch(request('/api/enter', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), env);
  assert.equal((await enter({ code: 'wrong' })).status, 401);
  assert.equal((await enter({ code: env.INVITE_CODE }, { Origin: 'https://other.test' })).status, 403);
  const accepted = await enter({ code: env.INVITE_CODE });
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get('Set-Cookie'), /HttpOnly/);
  env.ENTRY_LIMITER.limit = async () => ({ success: false });
  assert.equal((await enter({ code: env.INVITE_CODE })).status, 429);
  delete env.SESSION_SECRET;
  assert.equal((await enter({ code: env.INVITE_CODE })).status, 503);
});
test('private routes require access and storage has no public read/list route', async () => {
  const env = environment();
  assert.equal((await worker.fetch(request('/camera'), env)).status, 302);
  assert.equal((await worker.fetch(request('/preview'), env)).headers.get('Location'), '/enter');
  assert.equal((await worker.fetch(request('/api/photos', { method: 'POST', headers: { Origin: origin }, body: webp() }), env)).status, 401);
  assert.equal((await worker.fetch(request('/photos/private.webp'), env)).status, 404);
  const home = await worker.fetch(request('/'), env);
  assert.equal(home.headers.get('Cache-Control'), 'private, no-store');
  assert.match(home.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
});
test('upload stores clean bytes, ignores client state, deduplicates retries including races', async () => {
  const env = environment();
  const id = crypto.randomUUID();
  const results = await Promise.all([upload(env, id, webp(32, 24, true), { 'X-Status': 'published' }), upload(env, id, webp(32, 24, true))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.equal(env.objects.size, 1);
  const object = env.objects.get(`photos/${id}.webp`);
  assert.deepEqual(object.bytes, webp());
  assert.equal(object.customMetadata.status, undefined);
  assert.equal((await upload(env, id)).status, 200);
  assert.equal((await upload(env, id, webp(40, 40))).status, 409);
  assert.equal(env.objects.size, 1);
});
test('upload rejects invalid type, id, body and rate limit without storing anything', async () => {
  const env = environment();
  assert.equal((await upload(env, 'invalid')).status, 400);
  assert.equal((await upload(env, undefined, webp(), { 'Content-Type': 'image/jpeg' })).status, 415);
  assert.equal((await upload(env, undefined, new Uint8Array(5 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await upload(env, undefined, new Uint8Array(30))).status, 415);
  env.UPLOAD_LIMITER.limit = async () => ({ success: false });
  assert.equal((await upload(env)).status, 429);
  assert.equal(env.objects.size, 0);
});
test('body is bounded even when content length is absent or misleading', async () => {
  await assert.rejects(boundedBody(request('/', { method: 'POST', body: '123456', headers: { 'Content-Length': '2' } }), 5), { status: 413 });
});
test('storage failure is retryable and never reported as success or leaks details', async () => {
  const env = environment();
  env.PHOTOS.put = async () => { throw new Error('private infrastructure detail'); };
  const response = await upload(env);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private infrastructure/);
});

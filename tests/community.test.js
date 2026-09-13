import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../server/worker.js';
import { signToken } from '../server/tokens.js';
import { authorizeGoogleClaims } from '../server/google-auth.js';
import { cleanupDeleted, photoWeek } from '../server/community.js';
import { sanitizeWebP } from '../server/webp.js';

function env() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('../db/migrations/0001_groups.sql', import.meta.url), 'utf8'));
  const db = { withSession() { return this; }, prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; }
    };
  }, async batch(statements) { sqlite.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
  const objects = new Map();
  return { DB: db, sqlite, objects,
    INVITE_CODE: 'the-initial-invitation-for-tests', SESSION_SECRET: 'a-long-and-private-secret-for-testing-only', ADMIN_EMAILS: 'admin@example.com',
    ENTRY_LIMITER: { limit: async () => ({ success: true }) }, UPLOAD_LIMITER: { limit: async () => ({ success: true }) }, ASSETS: { fetch: async () => new Response('asset') },
    PHOTOS: { async put(key, bytes) { if (objects.has(key)) return null; objects.set(key, bytes); return {}; }, async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; }, async delete(key) { objects.delete(key); } }
  };
}
const origin = 'https://photown.test';
function call(e, path, method = 'GET', cookies = '', body, headers = {}) {
  const opts = { method, headers: { Origin: origin, Cookie: cookies, ...headers } };
  if (body !== undefined) { opts.body = body instanceof Uint8Array ? body : JSON.stringify(body); if (!(body instanceof Uint8Array)) opts.headers['Content-Type'] = 'application/json'; }
  return worker.fetch(new Request(origin + path, opts), e);
}
async function join(e, code = e.INVITE_CODE, cookies = '') {
  const response = await call(e, '/api/enter', 'POST', cookies, { code }); assert.equal(response.status, 200);
  const entries = new Map(cookies.split(';').filter(Boolean).map(v => v.trim().split('=')));
  response.headers.getSetCookie().forEach(v => { const [k, value] = v.split(';')[0].split('='); entries.set(k, value); });
  return [...entries].map(([k,v]) => `${k}=${v}`).join('; ');
}
const adminCookie = async e => 'photown_admin=' + await signToken(e, { sub: 'google-subject', email: 'admin@example.com' }, 'admin', 3600);
function image() {
  const b = new Uint8Array(30); b.set(Buffer.from('RIFF')); new DataView(b.buffer).setUint32(4,22,true); b.set(Buffer.from('WEBPVP8 '),8); new DataView(b.buffer).setUint32(16,10,true); b.set([0,0,0,0x9d,1,0x2a,16,0,16,0],20); return b;
}
const upload = (e, cookies, id = crypto.randomUUID()) => call(e, '/api/photos', 'POST', cookies, image(), { 'Content-Type': 'image/webp', 'Idempotency-Key': id });
test('persistent publisher survives re-entry; distinct browsers have distinct ownership', async () => {
  const e = env(), a = await join(e), b = await join(e);
  const onlyIdentity = a.split(';').find(c => c.trim().startsWith('photown_publisher='));
  await join(e, e.INVITE_CODE, onlyIdentity);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM publishers').get().n, 2);
  assert.notEqual(a, b);
});
test('pending photos are private; owner can describe and erase permanently; retries cannot resurrect', async () => {
  const e = env(), a = await join(e), b = await join(e), id = crypto.randomUUID();
  assert.equal((await upload(e, a, id)).status, 201);
  assert.equal((await upload(e, a, id)).status, 200);
  assert.equal((await upload(e, b, id)).status, 409);
  assert.equal((await call(e, `/api/images/${id}`, 'GET', b)).status, 404);
  assert.equal((await call(e, `/api/my-photos/${id}`, 'DELETE', b)).status, 404);
  assert.equal((await (await call(e, '/api/wall', 'GET', a)).json()).photos.length, 0);
  assert.equal((await call(e, `/api/my-photos/${id}/description`, 'POST', a, { description: 'Una sombra en una pared.' })).status, 200);
  assert.equal((await (await call(e, '/api/my-photos', 'GET', a)).json()).photos[0].description, 'Una sombra en una pared.');
  assert.equal((await call(e, `/api/my-photos/${id}`, 'DELETE', a)).status, 200);
  assert.equal(e.objects.size, 0);
  assert.equal((await call(e, `/api/images/${id}`, 'GET', a)).status, 404);
  assert.equal((await upload(e, a, id)).status, 410);
  assert.equal((await call(e, `/api/my-photos/${id}`, 'DELETE', a)).status, 200);
  const row = e.sqlite.prepare('SELECT * FROM photos WHERE id=?').get(id);
  assert.equal(row.publisher_id, null); assert.equal(row.sha256, null); assert.equal(row.description, '');
});
test('moderation and groups are server-authorized; published images stay within their group', async () => {
  const e = env(), a = await join(e), admin = await adminCookie(e), id = crypto.randomUUID();
  await upload(e, a, id);
  assert.equal((await call(e, '/api/admin/groups', 'GET', a)).status, 401);
  assert.equal((await call(e, `/api/admin/photos/${id}/approve`, 'POST', a)).status, 401);
  assert.equal((await call(e, `/api/admin/photos/${id}/approve`, 'POST', admin)).status, 200);
  assert.equal((await (await call(e, '/api/wall', 'GET', a)).json()).photos.length, 1);
  const group = await (await call(e, '/api/admin/groups', 'POST', admin, { name: 'Otro grupo' })).json();
  const b = await join(e, group.code);
  assert.equal((await call(e, `/api/images/${id}`, 'GET', b)).status, 404);
  assert.equal((await (await call(e, '/api/wall', 'GET', b)).json()).photos.length, 0);
  const publisher = e.sqlite.prepare("SELECT publisher_id FROM memberships WHERE group_id='default'").get().publisher_id;
  await call(e, `/api/admin/groups/default/publishers/${publisher}`, 'POST', admin, { status: 'BLOCKED' });
  assert.equal((await upload(e, a)).status, 403);
  await call(e, `/api/admin/groups/default/publishers/${publisher}`, 'POST', admin, { status: 'TRUSTED' });
  assert.equal((await (await upload(e, a)).json()).status, 'published');
  await call(e, '/api/admin/groups/default/active', 'POST', admin, { active: false });
  assert.equal((await call(e, `/api/images/${id}`, 'GET', a)).status, 404);
  assert.equal((await upload(e, a)).status, 401);
});
test('invitation rotation does not bootstrap the old code again; admin allowlist is checked each request', async () => {
  const e = env(); await join(e); const admin = await adminCookie(e);
  const rotated = await (await call(e, '/api/admin/groups/default/invitation', 'POST', admin)).json();
  assert.match(rotated.code, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.equal((await call(e, '/api/enter', 'POST', '', { code: e.INVITE_CODE })).status, 401);
  await join(e, ' ' + rotated.code.toLowerCase() + ' ');
  e.ADMIN_EMAILS = 'other@example.com';
  assert.equal((await call(e, '/api/admin/groups', 'GET', admin)).status, 401);
});
test('failed R2 deletion hides image immediately and scheduled cleanup removes bytes', async () => {
  const e = env(), a = await join(e), id = crypto.randomUUID(); await upload(e, a, id);
  const remove = e.PHOTOS.delete; e.PHOTOS.delete = async () => { throw new Error('R2 unavailable'); };
  assert.equal((await call(e, `/api/my-photos/${id}`, 'DELETE', a)).status, 503);
  assert.equal((await call(e, `/api/images/${id}`, 'GET', a)).status, 404);
  e.PHOTOS.delete = remove; await cleanupDeleted(e); assert.equal(e.objects.size, 0);
});
test('delete while upload is storing cannot republish the image', async () => {
  const e = env(), a = await join(e), id = crypto.randomUUID();
  const put = e.PHOTOS.put;
  e.PHOTOS.put = async (...args) => {
    assert.equal((await call(e, `/api/my-photos/${id}`, 'DELETE', a)).status, 200);
    return put(...args);
  };
  assert.equal((await upload(e, a, id)).status, 410); assert.equal(e.objects.size, 0);
});
test('Google rejects unverified, unauthorized or wrong-nonce accounts and fails closed when unconfigured', async () => {
  const e = env();
  assert.throws(() => authorizeGoogleClaims({ email: 'admin@example.com', email_verified: false, sub: 's', nonce: 'n' }, e, 'n'));
  assert.throws(() => authorizeGoogleClaims({ email: 'stranger@example.com', email_verified: true, sub: 's', nonce: 'n' }, e, 'n'));
  assert.throws(() => authorizeGoogleClaims({ email: 'admin@example.com', email_verified: true, sub: 's', nonce: 'wrong' }, e, 'n'));
  assert.equal((await (await call(e, '/api/admin/session')).json()).configured, false);
  assert.equal((await call(e, '/api/admin/google/callback?state=bad&code=bad')).headers.get('Location'), '/admin?login=failed');
  assert.equal((await call(e, '/api/admin/groups', 'POST', '', { name: 'invalid' })).status, 401);
});
test('cross-origin deletion is denied and ISO week follows Canary local time', async () => {
  const e = env(), a = await join(e), id = crypto.randomUUID(); await upload(e, a, id);
  assert.equal((await call(e, `/api/my-photos/${id}`, 'DELETE', a, undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(photoWeek(new Date('2026-09-13T23:30:00Z')), '2026-W38');
  assert.equal(photoWeek(new Date('2026-01-01T12:00:00Z')), '2026-W01');
  assert.ok(sanitizeWebP(image()));
});

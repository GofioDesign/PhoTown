import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../server/worker.js';
import { signToken } from '../server/tokens.js';
import { authorizeGoogleClaims } from '../server/google-auth.js';
import { cleanupDeleted, photoWeek, erasePhoto } from '../server/community.js';
import { sanitizeWebP } from '../server/webp.js';

function env() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('../db/migrations/0001_groups.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../db/migrations/0002_participant_alias.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../db/migrations/0003_waitlist.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../db/migrations/0004_profile_avatars.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../db/migrations/0005_core_v6.sql', import.meta.url), 'utf8'));
  const db = { withSession() { return this; }, prepare(sql) {
    let args = [];
    return { bind(...values) { args = values.map(value => Array.isArray(value) ? new Uint8Array(value) : value); return this; },
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

test('profile avatars follow photo visibility, group boundaries and explicit removal', async () => {
  const e = env(), a = await join(e), b = await join(e), admin = await adminCookie(e), id = crypto.randomUUID();
  await upload(e, a, id);
  const saved = await call(e, '/api/profile/avatar', 'PUT', a, image(), { 'Content-Type': 'image/webp' });
  assert.equal(saved.status, 200);
  assert.equal((await (await call(e, '/api/session', 'GET', a)).json()).has_avatar, true);
  assert.deepEqual(new Uint8Array(await (await call(e, '/api/profile/avatar', 'GET', a)).arrayBuffer()), image());
  assert.equal((await call(e, '/api/profile/avatar', 'GET', b)).status, 404);
  assert.equal((await call(e, `/api/photo-avatar/${id}`, 'GET', b)).status, 404);
  await call(e, `/api/admin/photos/${id}/approve`, 'POST', admin);
  assert.equal((await call(e, `/api/photo-avatar/${id}`, 'GET', b)).status, 200);
  assert.equal((await call(e, '/api/groups/default/cover', 'GET', b)).status, 200);
  const group = await (await call(e, '/api/admin/groups', 'POST', admin, { name: 'Other' })).json(), outsider = await join(e, group.code);
  assert.equal((await call(e, `/api/photo-avatar/${id}`, 'GET', outsider)).status, 404);
  assert.equal((await call(e, '/api/groups/default/cover', 'GET', outsider)).status, 404);
  await call(e, '/api/profile/avatar', 'DELETE', a);
  assert.equal((await call(e, `/api/photo-avatar/${id}`, 'GET', b)).status, 404);
  assert.equal((await call(e, '/api/profile/avatar', 'PUT', a, image(), { 'Content-Type': 'image/png' })).status, 415);
});

test('classroom wall requires Google administration and lists only published group photos', async () => {
  const e = env(), a = await join(e), admin = await adminCookie(e), published = crypto.randomUUID();
  await upload(e, a, published); await upload(e, a);
  await call(e, `/api/admin/photos/${published}/approve`, 'POST', admin);
  assert.equal((await call(e, '/api/admin/groups/default/wall', 'GET', a)).status, 401);
  const page = await (await call(e, '/api/admin/groups/default/wall', 'GET', admin)).json();
  assert.equal(page.group.name, 'PhoTown'); assert.deepEqual(page.photos.map(p => p.id), [published]);
  assert.equal('publisher_id' in page.photos[0], false);
});

test('personal library spans owned groups without exposing other participants or linking independent copies', async () => {
  const e = env(), a = await join(e), admin = await adminCookie(e);
  const group = await (await call(e, '/api/admin/groups', 'POST', admin, { name: 'Second group' })).json();
  const second = await join(e, group.code, a), outsider = await join(e, group.code);
  const firstId = crypto.randomUUID(), secondId = crypto.randomUUID(), otherId = crypto.randomUUID();
  await upload(e, a, firstId); await upload(e, second, secondId); await upload(e, outsider, otherId);
  const library = await (await call(e, '/api/library', 'GET', second)).json();
  assert.deepEqual(new Set(library.photos.map(p => p.id)), new Set([firstId, secondId]));
  assert.equal(library.photos.find(p => p.id === firstId).group_name, 'PhoTown');
  assert.equal((await call(e, `/api/images/${firstId}`, 'GET', second)).status, 200);
  assert.equal((await call(e, `/api/library/${firstId}/download`, 'GET', outsider)).status, 404);
  assert.equal((await call(e, `/api/library/${firstId}/description`, 'POST', outsider, { description: 'Not mine' })).status, 404);
  assert.equal((await call(e, `/api/library/${firstId}`, 'DELETE', outsider)).status, 404);
  assert.equal((await call(e, `/api/library/${firstId}`, 'DELETE', second)).status, 200);
  assert.equal((await call(e, `/api/library/${secondId}/download`, 'GET', second)).status, 200);
  assert.equal((await (await call(e, '/api/library', 'GET', second)).json()).photos.length, 1);
});

test('ownership is checked again before removal when identity recovery overtakes an old request', async () => {
  const e = env(), a = await join(e), b = await join(e), id = crypto.randomUUID();
  await upload(e, a, id);
  const photo = e.sqlite.prepare('SELECT * FROM photos WHERE id=?').get(id);
  const target = (await (await call(e, '/api/session', 'GET', b)).json()).identity;
  e.sqlite.prepare('UPDATE photos SET publisher_id=?,user_id=? WHERE id=?').run(target, target, id);
  await assert.rejects(erasePhoto(e, e.DB, photo, photo.publisher_id), /ya no está disponible/);
  assert.equal((await call(e, `/api/library/${id}/download`, 'GET', b)).status, 200);
});

test('waitlist validates, deduplicates privately, grants no access and is administered only by Google admins', async () => {
  const e = env();
  for (const email of ['', 'not an email', 'a@b', 'a@b.com\r\nX:evil', 'a'.repeat(255) + '@b.com']) assert.equal((await call(e, '/api/waitlist', 'POST', '', { email })).status, 400);
  const result = await call(e, '/api/waitlist', 'POST', '', { email: 'Person@Example.com' });
  assert.equal(result.status, 200); assert.equal(result.headers.get('Set-Cookie'), null);
  assert.equal((await call(e, '/api/waitlist', 'POST', '', { email: 'person@example.com' })).status, 200);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM waitlist').get().n, 1);
  assert.equal((await call(e, '/api/admin/waitlist')).status, 401);
  const participant = await join(e);
  assert.equal((await call(e, '/api/admin/waitlist', 'GET', participant)).status, 401);
  const admin = await adminCookie(e), list = await (await call(e, '/api/admin/waitlist', 'GET', admin)).json();
  assert.equal(list.entries[0].email, 'person@example.com');
  assert.equal((await call(e, `/api/admin/waitlist/${list.entries[0].id}`, 'DELETE', participant)).status, 401);
  assert.equal((await call(e, `/api/admin/waitlist/${list.entries[0].id}`, 'DELETE', admin)).status, 200);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM waitlist').get().n, 0);
  e.ENTRY_LIMITER.limit = async () => ({ success: false });
  assert.equal((await call(e, '/api/waitlist', 'POST', '', { email: 'other@example.com' })).status, 429);
  e.ENTRY_LIMITER.limit = async () => ({ success: true });
  assert.equal((await call(e, '/api/waitlist', 'POST', '', { email: 'other@example.com' }, { Origin: 'https://evil.example' })).status, 403);
});
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
  const download = await call(e, `/api/my-photos/${id}/download`, 'GET', a);
  assert.equal(download.status, 200); assert.match(download.headers.get('Content-Disposition'), /attachment; filename="photown-.*\.webp"/);
  assert.equal((await call(e, `/api/my-photos/${id}/download`, 'GET', b)).status, 404);
  assert.equal((await call(e, `/api/my-photos/${id}`, 'DELETE', b)).status, 404);
  assert.equal((await (await call(e, '/api/wall', 'GET', a)).json()).photos.length, 0);
  assert.equal((await call(e, `/api/my-photos/${id}/description`, 'POST', a, { description: 'Una sombra en una pared.' })).status, 200);
  assert.equal((await (await call(e, '/api/my-photos', 'GET', a)).json()).photos[0].description, 'Una sombra en una pared.');
  assert.equal((await call(e, `/api/my-photos/${id}`, 'DELETE', a)).status, 200);
  assert.equal(e.objects.size, 0);
  assert.equal((await call(e, `/api/images/${id}`, 'GET', a)).status, 404);
  assert.equal((await call(e, `/api/my-photos/${id}/download`, 'GET', a)).status, 404);
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

test('admin identity recovery transfers only this group and preserves moderation and deleted photos', async () => {
  const e = env(), old = await join(e), fresh = await join(e), admin = await adminCookie(e);
  const source = (await (await call(e, '/api/session', 'GET', old)).json()).identity;
  const target = (await (await call(e, '/api/session', 'GET', fresh)).json()).identity;
  const id = crypto.randomUUID(), removed = crypto.randomUUID();
  await upload(e, old, id); await upload(e, old, removed);
  await call(e, `/api/my-photos/${removed}`, 'DELETE', old);
  const group = await (await call(e, '/api/admin/groups', 'POST', admin, { name: 'Separate' })).json();
  const other = await join(e, group.code, old), otherPhoto = crypto.randomUUID(); await upload(e, other, otherPhoto);
  const path = '/api/admin/groups/default/recover-identity';
  assert.equal((await call(e, path, 'POST', fresh, { source, target })).status, 401);
  assert.equal((await call(e, path, 'POST', admin, { source, target: source })).status, 400);
  assert.equal((await call(e, path, 'POST', admin, { source, target: crypto.randomUUID() })).status, 400);
  assert.equal((await call(e, `/api/admin/groups/${group.id}/recover-identity`, 'POST', admin, { source, target })).status, 400);
  assert.deepEqual(await (await call(e, path, 'POST', admin, { source, target })).json(), { transferred: 1 });
  assert.equal((await call(e, `/api/images/${id}`, 'GET', old)).status, 404);
  const photos = (await (await call(e, '/api/my-photos', 'GET', fresh)).json()).photos;
  assert.equal(photos[0].id, id); assert.equal(photos[0].status, 'pending');
  assert.equal((await call(e, `/api/images/${removed}`, 'GET', fresh)).status, 404);
  assert.equal((await call(e, `/api/images/${otherPhoto}`, 'GET', other)).status, 200);
  assert.equal((await upload(e, old)).status, 403);
  assert.deepEqual(await (await call(e, path, 'POST', admin, { source, target })).json(), { transferred: 0 });
  assert.equal((await call(e, `/api/my-photos/${id}`, 'DELETE', fresh)).status, 200);
});

test('aliases are scoped to a group and CAMERA keeps one origin', async () => {
  const e = env(), a = await join(e), admin = await adminCookie(e);
  const group = await (await call(e, '/api/admin/groups', 'POST', admin, { name: 'Second' })).json();
  assert.equal((await call(e, '/api/groups/select', 'POST', a, { group: group.id })).status, 403);
  assert.equal((await call(e, '/api/photos', 'POST', a, image(), { 'Content-Type':'image/webp', 'Idempotency-Key':crypto.randomUUID(), 'X-Photown-Group':group.id })).status, 409);
  const both = await join(e, group.code, a);
  assert.equal((await (await call(e, '/api/groups', 'GET', both)).json()).groups.length, 2);
  assert.equal((await call(e, '/api/profile', 'POST', both, { alias: 'x'.repeat(41) })).status, 400);
  assert.equal((await call(e, '/api/profile', 'POST', both, { alias: ' Mirada ' })).status, 200);
  assert.equal((await (await call(e, '/api/session', 'GET', a)).json()).alias, '');
  assert.equal((await (await call(e, '/api/session', 'GET', both)).json()).alias, 'Mirada');
  const id = crypto.randomUUID();
  assert.equal((await call(e, '/api/photos', 'POST', both, image(), { 'Content-Type':'image/webp', 'Idempotency-Key':id, 'X-Photown-Group':group.id })).status, 201);
  await call(e, `/api/admin/photos/${id}/approve`, 'POST', admin);
  const wall = (await (await call(e, '/api/wall', 'GET', both)).json()).photos;
  assert.equal(wall[0].alias, 'Mirada'); assert.equal(wall[0].publisher_id, undefined);
  await call(e, '/api/profile', 'POST', both, { alias: '' });
  assert.equal((await (await call(e, '/api/wall', 'GET', both)).json()).photos[0].alias, '');
  assert.equal((await call(e, '/api/groups/select', 'POST', a, { group: group.id })).status, 200);
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

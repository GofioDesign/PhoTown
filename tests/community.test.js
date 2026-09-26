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
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_groups', '0002_participant_alias', '0003_waitlist', '0004_profile_avatars', '0005_accounts_challenges']) sqlite.exec(readFileSync(new URL(`../db/migrations/${file}.sql`, import.meta.url), 'utf8'));
  sqlite.prepare("INSERT INTO groups (id,name,invite_hash,created_at) VALUES ('default','PhoTown','placeholder',?)").run(new Date().toISOString());
  const db = { withSession() { return this; }, prepare(sql) {
    let args = [];
    return { bind(...values) { args = values.map(value => Array.isArray(value) ? new Uint8Array(value) : value); return this; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; }
    };
  }, async batch(statements) { sqlite.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
  const objects = new Map();
  return { DB: db, sqlite, objects, MAIL_OUTBOX: [],
    SESSION_SECRET: 'a-long-and-private-secret-for-testing-only', ADMIN_EMAILS: 'admin@example.com',
    ENTRY_LIMITER: { limit: async () => ({ success: true }) }, UPLOAD_LIMITER: { limit: async () => ({ success: true }) }, ASSETS: { fetch: async () => new Response('asset') },
    PHOTOS: { async put(key, bytes, options) { if (options?.onlyIf && objects.has(key)) return null; objects.set(key, bytes); return {}; }, async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; }, async delete(key) { objects.delete(key); } }
  };
}
const origin = 'https://photown.test';
function call(e, path, method = 'GET', cookies = '', body, headers = {}) {
  const opts = { method, headers: { Origin: origin, Cookie: cookies, ...headers } };
  if (body !== undefined) { opts.body = body instanceof Uint8Array || body instanceof FormData ? body : JSON.stringify(body); if (!(body instanceof Uint8Array) && !(body instanceof FormData)) opts.headers['Content-Type'] = 'application/json'; }
  return worker.fetch(new Request(origin + path, opts), e);
}
const merge = (cookies, response) => {
  const entries = new Map(cookies.split(';').filter(Boolean).map(v => v.trim().split('=')));
  response.headers.getSetCookie().forEach(v => { const [k, value] = v.split(';')[0].split('='); if (value) entries.set(k, value); else entries.delete(k); });
  return [...entries].map(([k, v]) => `${k}=${v}`).join('; ');
};
const lastMail = (e, email) => e.MAIL_OUTBOX.filter(m => m.to === email).at(-1);
const linkToken = message => /token=([a-f0-9]{64})/.exec(message.text)[1];
let people = 0;
// Invite by email (as an administrator) and sign in with the emailed link.
async function join(e, group = 'default', cookies = '', email) {
  if (!email && cookies) email = (await (await call(e, '/api/session', 'GET', cookies)).json()).email;
  email ||= `person${++people}@example.com`;
  const invited = await call(e, `/api/admin/groups/${group}/invitations`, 'POST', await adminCookie(e), { emails: [email] });
  assert.equal(invited.status, 200);
  const response = await call(e, '/api/login/verify', 'POST', cookies, { token: linkToken(lastMail(e, email)) });
  assert.equal(response.status, 200);
  const joined = merge(cookies, response);
  return merge(joined, await call(e, '/api/groups/select', 'POST', joined, { group }));
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
  const group = await (await call(e, '/api/admin/groups', 'POST', admin, { name: 'Other' })).json(), outsider = await join(e, group.id);
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
  const second = await join(e, group.id, a), outsider = await join(e, group.id);
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
  e.sqlite.prepare('UPDATE photos SET publisher_id=? WHERE id=?').run(target, id);
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
test('one account per email across devices; distinct emails have distinct ownership', async () => {
  const e = env(), a = await join(e, 'default', '', 'same@example.com'), b = await join(e);
  const phone = await join(e, 'default', '', 'same@example.com');
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM publishers').get().n, 2);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM sessions').get().n, 3);
  const id = crypto.randomUUID(); await upload(e, a, id);
  assert.equal((await call(e, `/api/images/${id}`, 'GET', phone)).status, 200);
  assert.equal((await call(e, `/api/images/${id}`, 'GET', b)).status, 404);
  assert.equal((await call(e, '/api/logout', 'POST', phone)).status, 200);
  assert.equal((await call(e, `/api/images/${id}`, 'GET', phone)).status, 404);
  assert.equal((await call(e, `/api/images/${id}`, 'GET', a)).status, 200);
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
  const b = await join(e, group.id);
  assert.equal((await call(e, `/api/images/${id}`, 'GET', b)).status, 404);
  assert.equal((await (await call(e, '/api/wall', 'GET', b)).json()).photos.length, 0);
  const publisher = e.sqlite.prepare("SELECT publisher_id FROM memberships WHERE group_id='default'").get().publisher_id;
  await call(e, `/api/admin/groups/default/publishers/${publisher}`, 'POST', admin, { status: 'BLOCKED' });
  assert.equal((await upload(e, a)).status, 403);
  await call(e, `/api/admin/groups/default/publishers/${publisher}`, 'POST', admin, { status: 'TRUSTED' });
  assert.equal((await (await upload(e, a)).json()).status, 'published');
  await call(e, '/api/admin/groups/default/active', 'POST', admin, { active: false });
  assert.equal((await call(e, `/api/images/${id}`, 'GET', a)).status, 404);
  assert.equal((await upload(e, a)).status, 409);
});
test('passwordless login: invited emails only, single-use links and codes, limited guesses, no enumeration', async () => {
  const e = env(), admin = await adminCookie(e);
  assert.equal((await call(e, '/api/enter', 'POST', '', { code: 'ANYTHING' })).status, 410);
  const stranger = await call(e, '/api/login', 'POST', '', { email: 'Stranger@Example.com' });
  assert.deepEqual(await stranger.json(), { sent: true });
  assert.equal(e.MAIL_OUTBOX.length, 0);
  assert.equal(e.sqlite.prepare('SELECT email FROM waitlist').get().email, 'stranger@example.com');
  assert.equal((await call(e, '/api/login', 'POST', '', { email: 'nope' })).status, 400);
  await call(e, '/api/admin/groups/default/invitations', 'POST', admin, { emails: ['guest@example.com'] });
  const invitation = lastMail(e, 'guest@example.com');
  assert.match(invitation.subject, /Invitación a PhoTown/); assert.match(invitation.html, /Aceptar la invitación/);
  const token = linkToken(invitation);
  const first = await call(e, '/api/login/verify', 'POST', '', { token });
  assert.equal(first.status, 200); assert.equal((await first.json()).group.id, 'default');
  assert.equal((await call(e, '/api/login/verify', 'POST', '', { token })).status, 401);
  // Code login: wrong guesses are counted and the token dies after five.
  await call(e, '/api/login', 'POST', '', { email: 'guest@example.com' });
  const code = /código en PhoTown: (\d{3}) (\d{3})/.exec(lastMail(e, 'guest@example.com').text).slice(1).join('');
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await call(e, '/api/login/verify', 'POST', '', { email: 'guest@example.com', code: wrong })).status, 401);
  assert.equal((await call(e, '/api/login/verify', 'POST', '', { email: 'guest@example.com', code })).status, 401);
  await call(e, '/api/login', 'POST', '', { email: 'guest@example.com' });
  const fresh = /código en PhoTown: (\d{3}) (\d{3})/.exec(lastMail(e, 'guest@example.com').text).slice(1).join(' ');
  const byCode = await call(e, '/api/login/verify', 'POST', '', { email: ' GUEST@example.com ', code: fresh });
  assert.equal(byCode.status, 200);
  // Repeated requests are throttled quietly.
  const before = e.MAIL_OUTBOX.length;
  for (let i = 0; i < 6; i++) await call(e, '/api/login', 'POST', '', { email: 'guest@example.com' });
  assert.ok(e.MAIL_OUTBOX.length - before <= 2);
  // Pending invitations can be revoked; accepted ones stay.
  await call(e, '/api/admin/groups/default/invitations', 'POST', admin, { emails: ['later@example.com'] });
  assert.equal((await call(e, '/api/admin/groups/default/invitations?email=later@example.com', 'DELETE', admin)).status, 200);
  const list = (await (await call(e, '/api/admin/groups/default/invitations', 'GET', admin)).json()).invitations;
  assert.deepEqual(list.map(i => i.email), ['guest@example.com']);
  assert.ok(list[0].accepted_at);
  const revoked = linkToken(lastMail(e, 'later@example.com'));
  const late = await call(e, '/api/login/verify', 'POST', '', { token: revoked });
  assert.equal((await late.json()).group, null);
  assert.equal((await call(e, '/api/wall', 'GET', merge('', late))).status, 409);
  e.ADMIN_EMAILS = 'other@example.com';
  assert.equal((await call(e, '/api/admin/groups', 'GET', admin)).status, 401);
});
test('an identity from the invitation-code era keeps its photos by claiming an email', async () => {
  const e = env(), token = 'a'.repeat(64), id = crypto.randomUUID();
  const { digest } = await import('../server/security.js');
  e.sqlite.prepare('INSERT INTO publishers (id,token_hash,created_at,last_seen) VALUES (?,?,?,?)').run('11111111-1111-4111-8111-111111111111', await digest(token), 'x', 'x');
  e.sqlite.prepare("INSERT INTO memberships (publisher_id,group_id) VALUES ('11111111-1111-4111-8111-111111111111','default')").run();
  const legacy = `photown_publisher=${token}`;
  assert.equal((await (await call(e, '/api/session', 'GET', legacy)).json()).group.id, 'default');
  assert.equal((await upload(e, legacy, id)).status, 201);
  const linked = await join(e, 'default', legacy, 'old@example.com');
  assert.equal(e.sqlite.prepare("SELECT email FROM publishers WHERE id='11111111-1111-4111-8111-111111111111'").get().email, 'old@example.com');
  const elsewhere = await join(e, 'default', '', 'old@example.com');
  assert.equal((await (await call(e, '/api/library', 'GET', elsewhere)).json()).photos[0].id, id);
  assert.ok(linked);
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
  const other = await join(e, group.id, old), otherPhoto = crypto.randomUUID(); await upload(e, other, otherPhoto);
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

test('aliases are optional and scoped to group; destination upload and switching require membership', async () => {
  const e = env(), a = await join(e), admin = await adminCookie(e);
  const group = await (await call(e, '/api/admin/groups', 'POST', admin, { name: 'Second' })).json();
  assert.equal((await call(e, '/api/groups/select', 'POST', a, { group: group.id })).status, 403);
  assert.equal((await call(e, '/api/photos', 'POST', a, image(), { 'Content-Type':'image/webp', 'Idempotency-Key':crypto.randomUUID(), 'X-Photown-Group':group.id })).status, 403);
  const both = await join(e, group.id, a);
  assert.equal((await (await call(e, '/api/groups', 'GET', both)).json()).groups.length, 2);
  assert.equal((await call(e, '/api/profile', 'POST', both, { alias: 'x'.repeat(41) })).status, 400);
  assert.equal((await call(e, '/api/profile', 'POST', both, { alias: ' Mirada ' })).status, 200);
  assert.equal((await (await call(e, '/api/session', 'GET', a)).json()).alias, '');
  assert.equal((await (await call(e, '/api/session', 'GET', both)).json()).alias, 'Mirada');
  const id = crypto.randomUUID();
  assert.equal((await call(e, '/api/photos', 'POST', a, image(), { 'Content-Type':'image/webp', 'Idempotency-Key':id, 'X-Photown-Group':group.id })).status, 201);
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

// Structural JPEG fixture: SOI, APP0, EXIF (to strip), DQT, SOF0, DHT, SOS, data, EOI.
function jpeg(width = 40, height = 30, exif = true) {
  const segment = (marker, payload) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
  const bytes = [0xff, 0xd8,
    ...segment(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(exif ? segment(0xe1, [...Buffer.from('Exif\0\0'), ...Array(20).fill(7)]) : []),
    ...segment(0xdb, [0, ...Array(64).fill(1)]),
    ...segment(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]),
    ...segment(0xc4, [0, ...Array(16).fill(0), ]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]), ...Array(24).fill(0x55), 0xff, 0xd9];
  return new Uint8Array(bytes);
}
const form = (photo, type, extra = {}) => {
  const body = new FormData(); body.append('photo', new Blob([photo], { type }), 'photo');
  for (const [key, value] of Object.entries(extra)) body.append(key, value);
  return body;
};
const send = (e, cookies, body, id = crypto.randomUUID(), headers = {}) => call(e, '/api/photos', 'POST', cookies, body, { 'Idempotency-Key': id, ...headers });

test('JPEG captures are accepted for browsers without WebP encoding, stripped of metadata and validated', async () => {
  const { sanitizeJPEG } = await import('../server/images.js');
  const clean = sanitizeJPEG(jpeg());
  assert.deepEqual([clean.width, clean.height], [40, 30]);
  assert.deepEqual(clean.bytes, sanitizeJPEG(jpeg(40, 30, false)).bytes);
  assert.equal(Buffer.from(clean.bytes).includes(Buffer.from('Exif')), false);
  assert.throws(() => sanitizeJPEG(jpeg(3000, 30)));
  assert.throws(() => sanitizeJPEG(jpeg().slice(0, -2)));
  const progressiveArithmetic = jpeg(); progressiveArithmetic[progressiveArithmetic.indexOf(0xc0, 20)] = 0xc9;
  assert.throws(() => sanitizeJPEG(progressiveArithmetic));
  const e = env(), a = await join(e), id = crypto.randomUUID();
  assert.equal((await call(e, '/api/photos', 'POST', a, jpeg(), { 'Content-Type': 'image/jpeg', 'Idempotency-Key': id })).status, 201);
  const stored = e.sqlite.prepare('SELECT content_type,image_key FROM photos WHERE id=?').get(id);
  assert.deepEqual([stored.content_type, stored.image_key.endsWith('.jpg')], ['image/jpeg', true]);
  const image = await call(e, `/api/images/${id}`, 'GET', a);
  assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
  assert.match((await call(e, `/api/library/${id}/download`, 'GET', a)).headers.get('Content-Disposition'), /\.jpg"$/);
  assert.equal((await call(e, '/api/photos', 'POST', a, jpeg(), { 'Content-Type': 'image/png', 'Idempotency-Key': crypto.randomUUID() })).status, 415);
});

test('multipart uploads store a wall thumbnail that follows the photo permissions and deletion', async () => {
  const e = env(), a = await join(e), b = await join(e), admin = await adminCookie(e), id = crypto.randomUUID();
  const body = form(image(), 'image/webp'); body.append('thumb', new Blob([jpeg(20, 15)], { type: 'image/jpeg' }), 'thumb');
  assert.equal((await send(e, a, body, id)).status, 201);
  assert.equal(e.objects.size, 2);
  assert.equal((await call(e, `/api/images/${id}?size=thumb`, 'GET', b)).status, 404);
  await call(e, `/api/admin/photos/${id}/approve`, 'POST', admin);
  const thumb = await call(e, `/api/images/${id}?size=thumb`, 'GET', b);
  assert.equal(thumb.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(thumb.headers.get('Cache-Control'), 'private, max-age=3600');
  assert.equal((await (await call(e, '/api/wall', 'GET', b)).json()).photos[0].has_thumb, 1);
  const oversized = form(image(), 'image/webp'); oversized.append('thumb', new Blob([jpeg(1200, 30)], { type: 'image/jpeg' }), 'thumb');
  assert.equal((await send(e, a, oversized)).status, 415);
  assert.equal((await call(e, `/api/library/${id}`, 'DELETE', a)).status, 200);
  assert.equal(e.objects.size, 0);
});

test('challenges: admins create them per group, uploads join open ones, walls filter by challenge', async () => {
  const e = env(), a = await join(e), b = await join(e), admin = await adminCookie(e);
  assert.equal((await call(e, '/api/admin/groups/default/challenges', 'POST', admin, { title: 'Tercios', grid: 'hexagons' })).status, 400);
  const { id: challenge } = await (await call(e, '/api/admin/groups/default/challenges', 'POST', admin, { title: 'Regla de tercios', prompt: 'Coloca el sujeto en una intersección.', grid: 'thirds', ends_at: '2026-10-04' })).json();
  const list = (await (await call(e, '/api/challenges', 'GET', a)).json()).challenges;
  assert.deepEqual([list[0].title, list[0].grid, list[0].active], ['Regla de tercios', 'thirds', 1]);
  assert.equal((await (await call(e, '/api/notifications', 'GET', b)).json()).notifications[0].kind, 'challenge');
  const inChallenge = crypto.randomUUID(), outside = crypto.randomUUID();
  assert.equal((await send(e, a, form(image(), 'image/webp', { challenge }), inChallenge)).status, 201);
  assert.equal((await send(e, a, form(image(), 'image/webp'), outside)).status, 201);
  await call(e, `/api/admin/photos/${inChallenge}/approve`, 'POST', admin); await call(e, `/api/admin/photos/${outside}/approve`, 'POST', admin);
  const filtered = (await (await call(e, `/api/wall?challenge=${challenge}`, 'GET', b)).json()).photos;
  assert.deepEqual(filtered.map(p => p.id), [inChallenge]); assert.equal(filtered[0].challenge_title, 'Regla de tercios');
  assert.equal((await (await call(e, '/api/wall', 'GET', b)).json()).photos.length, 2);
  assert.equal((await (await call(e, '/api/challenges', 'GET', a)).json()).challenges[0].mine, 1);
  const other = await (await call(e, '/api/admin/groups', 'POST', admin, { name: 'Otro' })).json();
  const stranger = await join(e, other.id);
  assert.equal((await send(e, stranger, form(image(), 'image/webp', { challenge }))).status, 409);
  assert.equal((await call(e, `/api/admin/challenges/${challenge}`, 'POST', admin, { active: false })).status, 200);
  assert.equal((await send(e, a, form(image(), 'image/webp', { challenge }))).status, 409);
  assert.equal((await call(e, `/api/admin/challenges/${challenge}`, 'POST', a, { active: true })).status, 401);
  const adminWall = await (await call(e, `/api/admin/groups/default/wall?challenge=${challenge}`, 'GET', admin)).json();
  assert.equal(adminWall.photos.length, 1); assert.equal(adminWall.challenges[0].id, challenge);
});

test('reactions: members react to published photos, authors are notified once, counts are shared', async () => {
  const e = env(), a = await join(e), b = await join(e), admin = await adminCookie(e), id = crypto.randomUUID();
  await upload(e, a, id);
  assert.equal((await call(e, `/api/photos/${id}/reactions`, 'POST', b, { kind: 'like', active: true })).status, 404);
  await call(e, `/api/admin/photos/${id}/approve`, 'POST', admin);
  assert.equal((await call(e, `/api/photos/${id}/reactions`, 'POST', b, { kind: 'hate', active: true })).status, 400);
  await call(e, `/api/photos/${id}/reactions`, 'POST', b, { kind: 'light', active: true });
  const summary = await (await call(e, `/api/photos/${id}/reactions`, 'POST', b, { kind: 'light', active: true })).json();
  assert.equal(summary.counts.light, 1); assert.deepEqual(summary.mine, ['light']);
  const own = await (await call(e, `/api/photos/${id}/reactions`, 'GET', a)).json();
  assert.deepEqual(own.mine, []); assert.equal(own.counts.light, 1);
  const inbox = (await (await call(e, '/api/notifications', 'GET', a)).json()).notifications;
  assert.deepEqual(inbox.map(n => n.kind), ['reaction', 'approved']);
  assert.match(inbox[0].text, /Buena luz/);
  assert.equal((await (await call(e, '/api/wall', 'GET', b)).json()).photos[0].reacted, 1);
  await call(e, `/api/photos/${id}/reactions`, 'POST', b, { kind: 'light', active: false });
  assert.equal((await (await call(e, `/api/photos/${id}/reactions`, 'GET', a)).json()).counts.light, 0);
  await call(e, `/api/photos/${id}/reactions`, 'POST', b, { kind: 'idea', active: true });
  await call(e, `/api/library/${id}`, 'DELETE', a);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM reactions').get().n, 0);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM notifications WHERE photo_id=?').get(id).n, 0);
});

test('notifications: new photos reach other members; hourly digests email members and administrators', async () => {
  const e = env(), a = await join(e, 'default', '', 'author@example.com'), b = await join(e, 'default', '', 'friend@example.com'), admin = await adminCookie(e);
  const quiet = await join(e, 'default', '', 'quiet@example.com');
  await call(e, '/api/preferences', 'POST', quiet, { digest: false });
  const id = crypto.randomUUID(); await upload(e, a, id);
  e.MAIL_OUTBOX.length = 0;
  await cleanupDeleted(e);
  const adminMail = lastMail(e, 'admin@example.com');
  assert.match(adminMail.subject, /Una foto espera aprobación/); assert.match(adminMail.text, /PhoTown: 1 foto nueva/);
  e.MAIL_OUTBOX.length = 0; await cleanupDeleted(e);
  assert.equal(lastMail(e, 'admin@example.com'), undefined);
  await call(e, `/api/admin/photos/${id}/approve`, 'POST', admin);
  await call(e, `/api/admin/photos/${id}/approve`, 'POST', admin);
  const session = await (await call(e, '/api/session', 'GET', b)).json();
  assert.equal(session.unread, 1);
  assert.equal((await (await call(e, '/api/notifications', 'GET', b)).json()).notifications[0].kind, 'photo');
  await cleanupDeleted(e);
  assert.match(lastMail(e, 'friend@example.com').text, /ha publicado una foto en PhoTown/);
  assert.match(lastMail(e, 'author@example.com').text, /Tu foto ya está en el muro/);
  assert.equal(lastMail(e, 'quiet@example.com'), undefined);
  e.MAIL_OUTBOX.length = 0; await cleanupDeleted(e);
  assert.equal(e.MAIL_OUTBOX.length, 0);
  await call(e, '/api/notifications/read', 'POST', b);
  assert.equal((await (await call(e, '/api/session', 'GET', b)).json()).unread, 0);
  const trusted = e.sqlite.prepare("SELECT publisher_id FROM memberships m JOIN publishers p ON p.id=m.publisher_id WHERE p.email='author@example.com'").get().publisher_id;
  await call(e, `/api/admin/groups/default/publishers/${trusted}`, 'POST', admin, { status: 'TRUSTED' });
  await upload(e, a);
  assert.equal((await (await call(e, '/api/session', 'GET', b)).json()).unread, 1);
  const members = (await (await call(e, '/api/admin/groups/default/publishers', 'GET', admin)).json()).publishers;
  assert.ok(members.some(m => m.email === 'friend@example.com'));
  const groups = (await (await call(e, '/api/admin/groups', 'GET', admin)).json()).groups;
  assert.equal(groups[0].members, 3);
});

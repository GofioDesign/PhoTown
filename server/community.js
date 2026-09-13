import { digest, HttpError, boundedBody, requireSameOrigin } from './security.js';
import { cookieValue, cookieHeader, randomToken, signToken, verifyToken } from './tokens.js';
import { googleStart, googleCallback, googleReady, adminIdentity } from './google-auth.js';
import { sanitizeWebP } from './webp.js';

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const now = () => new Date().toISOString();
async function bodyJSON(request, limit = 4096) {
  try { return JSON.parse(new TextDecoder().decode(await boundedBody(request, limit))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Revisa los datos y vuelve a intentar.'); }
}
async function rate(binding, key) {
  if (!binding || !(await binding.limit({ key })).success) throw new HttpError(429, 'Espera un minuto antes de volver a intentar.');
}
export function photoWeek(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Atlantic/Canary', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => Number(parts.find(p => p.type === type).value);
  const day = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const start = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return `${day.getUTCFullYear()}-W${String(Math.ceil((((day - start) / 86400000) + 1) / 7)).padStart(2, '0')}`;
}
async function identity(request, env, db) {
  const token = cookieValue(request, 'photown_publisher');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare('SELECT id FROM publishers WHERE token_hash=?').bind(await digest(token)).first();
}
async function participant(request, env, db) {
  const [publisher, access] = await Promise.all([identity(request, env, db), verifyToken(env, cookieValue(request, 'photown_group'), 'participant')]);
  if (!publisher || !access || access.publisher !== publisher.id) return null;
  const member = await db.prepare('SELECT m.status,g.id AS group_id,g.name,g.active FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.publisher_id=? AND m.group_id=?').bind(publisher.id, access.group).first();
  return member?.active ? { ...member, publisher_id: publisher.id } : null;
}
async function enter(request, env, db) {
  await rate(env.ENTRY_LIMITER, await digest(request.headers.get('CF-Connecting-IP') || 'local'));
  const body = await bodyJSON(request, 1024);
  if (typeof body?.code !== 'string' || body.code.length > 256) throw new HttpError(400, 'Introduce un código de invitación.');
  // Bootstrap only once. Rotating this group's invitation never restores the old code.
  await db.prepare('INSERT OR IGNORE INTO groups (id,name,invite_hash,created_at) VALUES (?,?,?,?)').bind('default', 'PhoTown', await digest(env.INVITE_CODE), now()).run();
  const group = await db.prepare('SELECT id FROM groups WHERE invite_hash=? AND active=1').bind(await digest(body.code.trim())).first();
  if (!group) throw new HttpError(401, 'El código no es correcto o el grupo está cerrado.');
  let publisher = await identity(request, env, db), token;
  if (!publisher) {
    token = randomToken(); publisher = { id: crypto.randomUUID() };
    await db.prepare('INSERT INTO publishers VALUES (?,?,?,?)').bind(publisher.id, await digest(token), now(), now()).run();
  }
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO memberships (publisher_id,group_id) VALUES (?,?)').bind(publisher.id, group.id),
    db.prepare('UPDATE publishers SET last_seen=? WHERE id=?').bind(now(), publisher.id)
  ]);
  const headers = new Headers();
  if (token) headers.append('Set-Cookie', cookieHeader(request, 'photown_publisher', token, 31536000));
  headers.append('Set-Cookie', cookieHeader(request, 'photown_group', await signToken(env, { publisher: publisher.id, group: group.id }, 'participant', 43200), 43200));
  return json({ authenticated: true }, 200, headers);
}
async function listPhotos(db, where, bindings, url) {
  const cursor = url.searchParams.get('before');
  const args = [...bindings];
  let clause = where;
  if (cursor) {
    let pair; try { pair = JSON.parse(atob(cursor)); } catch { throw new HttpError(400, 'La página solicitada no es válida.'); }
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(v => typeof v === 'string' && v.length < 100)) throw new HttpError(400, 'La página solicitada no es válida.');
    clause += ' AND (created_at < ? OR (created_at = ? AND id < ?))'; args.push(pair[0], pair[0], pair[1]);
  }
  const result = await db.prepare(`SELECT id,description,status,week,created_at,publisher_id FROM photos WHERE ${clause} ORDER BY created_at DESC,id DESC LIMIT 25`).bind(...args).all();
  const more = result.results.length > 24, photos = result.results.slice(0, 24), last = photos.at(-1);
  return { photos, next: more ? btoa(JSON.stringify([last.created_at, last.id])) : null };
}
async function upload(request, env, db, user) {
  if (user.status === 'BLOCKED') throw new HttpError(403, 'Tu participación está bloqueada. Contacta con la persona que coordina el grupo.');
  await rate(env.UPLOAD_LIMITER, user.publisher_id);
  const id = request.headers.get('Idempotency-Key');
  if (!uuid.test(id || '')) throw new HttpError(400, 'No se reconoce el envío. Vuelve a fotografiar.');
  if (request.headers.get('Content-Type') !== 'image/webp') throw new HttpError(415, 'Solo se admiten fotografías WebP.');
  const image = sanitizeWebP(await boundedBody(request, 5 * 1024 * 1024)), hash = await digest(image.bytes);
  const key = `groups/${user.group_id}/photos/${id}.webp`;
  const created = await db.prepare("INSERT OR IGNORE INTO photos (id,publisher_id,group_id,image_key,sha256,status,week,created_at) VALUES (?,?,?,?,?,'uploading',?,?)").bind(id, user.publisher_id, user.group_id, key, hash, photoWeek(), now()).run();
  const photo = await db.prepare('SELECT * FROM photos WHERE id=?').bind(id).first();
  if (['deleted', 'deleting'].includes(photo.status)) throw new HttpError(410, 'Esta fotografía se ha borrado y no se puede reenviar.');
  if (photo.publisher_id !== user.publisher_id || photo.group_id !== user.group_id || photo.sha256 !== hash) throw new HttpError(409, 'Este envío corresponde a otra fotografía.');
  if (photo.status !== 'uploading') return json({ id, status: photo.status });
  await env.PHOTOS.put(key, image.bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'image/webp', cacheControl: 'private, no-store' } });
  // Recheck authority after storage. Client-supplied status is never accepted.
  await db.prepare("UPDATE photos SET status=CASE WHEN (SELECT status FROM memberships WHERE publisher_id=? AND group_id=?)='TRUSTED' THEN 'published' ELSE 'pending' END WHERE id=? AND status='uploading' AND EXISTS(SELECT 1 FROM memberships m JOIN groups g ON m.group_id=g.id WHERE m.publisher_id=? AND m.group_id=? AND m.status!='BLOCKED' AND g.active=1)").bind(user.publisher_id, user.group_id, id, user.publisher_id, user.group_id).run();
  const final = await db.prepare('SELECT status FROM photos WHERE id=?').bind(id).first();
  if (['deleting', 'deleted'].includes(final.status)) { await env.PHOTOS.delete(key); throw new HttpError(410, 'Esta fotografía se ha borrado.'); }
  if (final.status === 'uploading') { await erasePhoto(env, db, photo); throw new HttpError(403, 'No se puede publicar en este grupo.'); }
  return json({ id, status: final.status }, created.meta.changes ? 201 : 200);
}
export async function erasePhoto(env, db, photo) {
  // Withdraw first. If R2 fails, the image stays inaccessible and cleanup retries.
  await db.prepare("UPDATE photos SET status='deleting',description='' WHERE id=? AND status!='deleted'").bind(photo.id).run();
  await env.PHOTOS.delete(photo.image_key);
  // Keep only a tombstone/key to prevent upload replay and clean up late writers.
  await db.prepare("UPDATE photos SET status='deleted',publisher_id=NULL,group_id=NULL,sha256=NULL,description='',week=NULL,cleaned_at=? WHERE id=?").bind(now(), photo.id).run();
}
export async function cleanupDeleted(env) {
  if (!env.DB) return;
  const db = env.DB.withSession('first-primary');
  const { results } = await db.prepare("SELECT id,image_key FROM photos WHERE status IN ('deleting','deleted') ORDER BY CASE WHEN status='deleting' THEN 0 ELSE 1 END,COALESCE(cleaned_at,'') LIMIT 100").all();
  for (const photo of results) await erasePhoto(env, db, photo);
  await db.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(Math.floor(Date.now() / 1000)).run();
}
async function adminRoutes(request, env, db, url) {
  const admin = await adminIdentity(request, env);
  if (url.pathname === '/api/admin/session' && request.method === 'GET') return json({ authenticated: Boolean(admin), email: admin?.email, configured: googleReady(env) });
  if (!admin) throw new HttpError(401, 'Entra con una cuenta de Google autorizada.');
  if (request.method !== 'GET') await rate(env.UPLOAD_LIMITER, `admin:${admin.sub}`);
  if (url.pathname === '/api/admin/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(request, 'photown_admin', '', 0) });
  if (url.pathname === '/api/admin/groups') {
    if (request.method === 'GET') return json({ groups: (await db.prepare('SELECT id,name,active,created_at FROM groups ORDER BY created_at DESC,id DESC').all()).results });
    if (request.method === 'POST') {
      const body = await bodyJSON(request);
      if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new HttpError(400, 'Escribe un nombre de grupo de hasta 80 caracteres.');
      const id = crypto.randomUUID(), code = randomToken().slice(0, 24);
      await db.prepare('INSERT INTO groups (id,name,invite_hash,created_at) VALUES (?,?,?,?)').bind(id, body.name.trim(), await digest(code), now()).run();
      return json({ id, code }, 201);
    }
  }
  const groupAction = /^\/api\/admin\/groups\/([a-z0-9-]+)\/(invitation|active|photos|publishers)$/.exec(url.pathname);
  if (groupAction) {
    const [, group, action] = groupAction;
    if (!(await db.prepare('SELECT id FROM groups WHERE id=?').bind(group).first())) throw new HttpError(404, 'No se encuentra el grupo.');
    if (action === 'invitation' && request.method === 'POST') {
      const code = randomToken().slice(0, 24);
      await db.prepare('UPDATE groups SET invite_hash=? WHERE id=?').bind(await digest(code), group).run();
      return json({ code });
    }
    if (action === 'active' && request.method === 'POST') {
      const body = await bodyJSON(request);
      if (typeof body?.active !== 'boolean') throw new HttpError(400, 'Estado de grupo no válido.');
      await db.prepare('UPDATE groups SET active=? WHERE id=?').bind(Number(body.active), group).run(); return json({ ok: true });
    }
    if (action === 'photos' && request.method === 'GET') return json(await listPhotos(db, "group_id=? AND status IN ('pending','published','hidden')", [group], url));
    if (action === 'publishers' && request.method === 'GET') return json({ publishers: (await db.prepare('SELECT m.publisher_id,m.status,p.created_at,p.last_seen FROM memberships m JOIN publishers p ON p.id=m.publisher_id WHERE m.group_id=? ORDER BY p.created_at LIMIT 200').bind(group).all()).results });
  }
  const photoAction = /^\/api\/admin\/photos\/([a-f0-9-]+)\/(approve|hide|trust|delete)$/.exec(url.pathname);
  if (photoAction && request.method === 'POST') {
    const photo = await db.prepare("SELECT * FROM photos WHERE id=? AND status IN ('pending','published','hidden','deleting')").bind(photoAction[1]).first();
    if (!photo) throw new HttpError(404, 'No se encuentra la fotografía.');
    const action = photoAction[2];
    if (action === 'delete') await erasePhoto(env, db, photo);
    else {
      const statements = [db.prepare("UPDATE photos SET status=? WHERE id=? AND status IN ('pending','published','hidden')").bind(action === 'hide' ? 'hidden' : 'published', photo.id)];
      if (action === 'trust') statements.push(db.prepare("UPDATE memberships SET status='TRUSTED' WHERE publisher_id=? AND group_id=? AND status!='BLOCKED'").bind(photo.publisher_id, photo.group_id));
      await db.batch(statements);
    }
    return json({ ok: true });
  }
  const memberAction = /^\/api\/admin\/groups\/([a-z0-9-]+)\/publishers\/([a-f0-9-]+)$/.exec(url.pathname);
  if (memberAction && request.method === 'POST') {
    const body = await bodyJSON(request);
    if (!['MODERATED','TRUSTED','BLOCKED'].includes(body?.status)) throw new HttpError(400, 'Estado no válido.');
    await db.prepare('UPDATE memberships SET status=? WHERE group_id=? AND publisher_id=?').bind(body.status, memberAction[1], memberAction[2]).run(); return json({ ok: true });
  }
  throw new HttpError(404, 'Esta operación no está disponible.');
}
export async function communityRoute(request, env) {
  const url = new URL(request.url), path = url.pathname;
  const db = env.DB.withSession('first-primary');
  if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request);
  if (path === '/api/admin/google/start' && request.method === 'GET') {
    await rate(env.ENTRY_LIMITER, await digest(request.headers.get('CF-Connecting-IP') || 'local'));
    return googleStart(request, env, db);
  }
  if (path === '/api/admin/google/callback' && request.method === 'GET') return googleCallback(request, env, db);
  if (path.startsWith('/api/admin/')) return adminRoutes(request, env, db, url);
  if (path === '/api/enter' && request.method === 'POST') return enter(request, env, db);
  const user = await participant(request, env, db);
  if (path === '/api/session' && request.method === 'GET') return json({ authenticated: Boolean(user), group: user ? { id: user.group_id, name: user.name } : null, status: user?.status });
  const imageMatch = /^\/api\/images\/([a-f0-9-]+)$/.exec(path);
  if (imageMatch && request.method === 'GET') {
    const photo = await db.prepare("SELECT * FROM photos WHERE id=? AND status IN ('pending','published','hidden')").bind(imageMatch[1]).first();
    const allowed = photo && ((user && photo.group_id === user.group_id && (photo.publisher_id === user.publisher_id || photo.status === 'published')) || await adminIdentity(request, env));
    if (!allowed) throw new HttpError(404, 'No se encuentra la fotografía.');
    const object = await env.PHOTOS.get(photo.image_key);
    if (!object) throw new HttpError(404, 'No se encuentra la fotografía.');
    return new Response(object.body, { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store' } });
  }
  if (!path.startsWith('/api/')) {
    if (path === '/admin') return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    if (!user) return new Response(null, { status: 302, headers: { Location: '/enter' } });
    return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
  }
  if (!user) throw new HttpError(401, 'Tu acceso ha caducado. Introduce de nuevo tu invitación.');
  if (path === '/api/photos' && request.method === 'POST') return upload(request, env, db, user);
  if (path === '/api/my-photos' && request.method === 'GET') return json(await listPhotos(db, "group_id=? AND publisher_id=? AND status NOT IN ('deleted')", [user.group_id, user.publisher_id], url));
  if (path === '/api/wall' && request.method === 'GET') {
    const page = await listPhotos(db, "group_id=? AND status='published'", [user.group_id], url);
    page.photos.forEach(photo => { delete photo.publisher_id; }); return json(page);
  }
  const own = /^\/api\/my-photos\/([a-f0-9-]+)(\/description)?$/.exec(path);
  if (own) {
    if (request.method === 'DELETE' && (await db.prepare("SELECT id FROM photos WHERE id=? AND status='deleted'").bind(own[1]).first())) return json({ deleted: true });
    const photo = await db.prepare('SELECT * FROM photos WHERE id=? AND publisher_id=? AND group_id=?').bind(own[1], user.publisher_id, user.group_id).first();
    if (!photo) throw new HttpError(404, 'No se encuentra esta fotografía entre tus fotos.');
    if (request.method === 'DELETE' && !own[2]) { await erasePhoto(env, db, photo); return json({ deleted: true }); }
    if (request.method === 'POST' && own[2]) {
      const body = await bodyJSON(request);
      if (typeof body?.description !== 'string' || body.description.length > 500) throw new HttpError(400, 'La descripción debe tener como máximo 500 caracteres.');
      await db.prepare("UPDATE photos SET description=? WHERE id=? AND status NOT IN ('deleting','deleted')").bind(body.description.trim(), photo.id).run(); return json({ ok: true });
    }
  }
  throw new HttpError(404, 'Esta operación no está disponible.');
}

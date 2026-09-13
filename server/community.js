import { digest, HttpError, boundedBody, requireSameOrigin } from './security.js';
import { cookieValue, cookieHeader, randomToken, invitationCode, signToken, verifyToken } from './tokens.js';
import { googleStart, googleCallback, googleReady, adminIdentity, adminEmails } from './google-auth.js';
import { sanitizeWebP } from './webp.js';
import { addPhotoToCurrentWall, createInitialWall, ensureAdminPrincipal, ensureGroupMembership, ensureLocalUser, groupAuthority, requireGroupAuthority } from './core-v6.js';

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
  return db.prepare('SELECT id,user_id FROM publishers WHERE token_hash=?').bind(await digest(token)).first();
}
async function participant(request, env, db) {
  const [publisher, access] = await Promise.all([identity(request, env, db), verifyToken(env, cookieValue(request, 'photown_group'), 'participant')]);
  if (!publisher || !access || access.publisher !== publisher.id) return null;
  const member = await db.prepare(`SELECT
    CASE WHEN gm.state='blocked' THEN 'BLOCKED' WHEN gm.trust=1 THEN 'TRUSTED' ELSE m.status END AS status,
    m.alias,g.id AS group_id,g.name,g.active,g.operational_state,
    gm.user_id,gm.par_id,gm.role,gm.state AS membership_state,gm.trust
    FROM memberships m
    JOIN groups g ON g.id=m.group_id
    JOIN group_memberships gm ON gm.user_id=? AND gm.group_id=m.group_id
    WHERE m.publisher_id=? AND m.group_id=?`).bind(publisher.user_id, publisher.id, access.group).first();
  return member?.active && member.membership_state !== 'left' ? { ...member, publisher_id: publisher.id } : null;
}
async function enter(request, env, db) {
  await rate(env.ENTRY_LIMITER, await digest(request.headers.get('CF-Connecting-IP') || 'local'));
  const body = await bodyJSON(request, 1024);
  if (typeof body?.code !== 'string' || body.code.length > 256) throw new HttpError(400, 'Introduce un código de invitación.');
  // Bootstrap only once. Rotating this group's invitation never restores the old code.
  await db.prepare('INSERT OR IGNORE INTO groups (id,name,invite_hash,created_at) VALUES (?,?,?,?)').bind('default', 'PhoTown', await digest(env.INVITE_CODE), now()).run();
  const submitted = body.code.trim();
  const normalized = /^[a-z2-9]{8}$/i.test(submitted) ? submitted.toUpperCase() : submitted;
  const group = await db.prepare('SELECT id FROM groups WHERE invite_hash=? AND active=1').bind(await digest(normalized)).first();
  if (!group) throw new HttpError(401, 'El código no es correcto o el grupo está cerrado.');
  if (!(await db.prepare("SELECT id FROM walls WHERE group_id=? AND state='open'").bind(group.id).first())) {
    const groupData = await db.prepare('SELECT name,created_at FROM groups WHERE id=?').bind(group.id).first();
    await createInitialWall(db, group.id, groupData.name, groupData.created_at);
  }
  let publisher = await identity(request, env, db), token;
  if (!publisher) {
    token = randomToken(); publisher = { id: crypto.randomUUID() };
    publisher.user_id = publisher.id;
    await db.batch([
      db.prepare("INSERT INTO users (id,status,created_at) VALUES (?,'active',?)").bind(publisher.user_id, now()),
      db.prepare('INSERT INTO publishers (id,token_hash,created_at,last_seen,user_id) VALUES (?,?,?,?,?)').bind(publisher.id, await digest(token), now(), now(), publisher.user_id)
    ]);
  }
  publisher.user_id ||= await ensureLocalUser(db, publisher.id);
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO memberships (publisher_id,group_id) VALUES (?,?)').bind(publisher.id, group.id),
    db.prepare('UPDATE publishers SET last_seen=? WHERE id=?').bind(now(), publisher.id)
  ]);
  const legacy = await db.prepare('SELECT status FROM memberships WHERE publisher_id=? AND group_id=?').bind(publisher.id, group.id).first();
  await ensureGroupMembership(db, publisher.user_id, group.id, legacy?.status);
  const headers = new Headers();
  if (token) headers.append('Set-Cookie', cookieHeader(request, 'photown_publisher', token, 31536000));
  headers.append('Set-Cookie', cookieHeader(request, 'photown_group', await signToken(env, { publisher: publisher.id, group: group.id }, 'participant', 43200), 43200));
  return json({ authenticated: true }, 200, headers);
}
async function listPhotos(db, where, bindings, url, library = false) {
  const cursor = url.searchParams.get('before');
  const args = [...bindings];
  let clause = where;
  if (cursor) {
    let pair; try { pair = JSON.parse(atob(cursor)); } catch { throw new HttpError(400, 'La página solicitada no es válida.'); }
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(v => typeof v === 'string' && v.length < 100)) throw new HttpError(400, 'La página solicitada no es válida.');
    clause += ' AND (created_at < ? OR (created_at = ? AND id < ?))'; args.push(pair[0], pair[0], pair[1]);
  }
  const result = await db.prepare(`SELECT id,description,status,week,created_at,publisher_id,${library ? 'group_id,(SELECT name FROM groups WHERE groups.id=photos.group_id) AS group_name,' : ''}(EXISTS(SELECT 1 FROM profile_avatars a WHERE a.publisher_id=photos.publisher_id AND a.group_id=photos.group_id)) AS has_avatar,(SELECT alias FROM memberships WHERE memberships.publisher_id=photos.publisher_id AND memberships.group_id=photos.group_id) AS alias FROM photos WHERE ${clause} ORDER BY created_at DESC,id DESC LIMIT 25`).bind(...args).all();
  const more = result.results.length > 24, photos = result.results.slice(0, 24), last = photos.at(-1);
  return { photos, next: more ? btoa(JSON.stringify([last.created_at, last.id])) : null };
}
async function upload(request, env, db, user) {
  if (user.membership_state !== 'active') throw new HttpError(403, 'Tu participación no permite publicar en este grupo.');
  if (user.operational_state !== 'active') throw new HttpError(409, 'Este grupo no admite nuevas fotografías en este momento.');
  await rate(env.UPLOAD_LIMITER, user.publisher_id);
  const id = request.headers.get('Idempotency-Key');
  if (!uuid.test(id || '')) throw new HttpError(400, 'No se reconoce el envío. Vuelve a fotografiar.');
  if (request.headers.get('Content-Type') !== 'image/webp') throw new HttpError(415, 'Solo se admiten fotografías WebP.');
  const image = sanitizeWebP(await boundedBody(request, 5 * 1024 * 1024)), hash = await digest(image.bytes);
  const key = `groups/${user.group_id}/photos/${id}.webp`;
  const createdAt = now();
  const created = await db.prepare("INSERT OR IGNORE INTO photos (id,publisher_id,group_id,image_key,sha256,status,week,created_at,user_id,par_id,origin_type,storage_bytes) VALUES (?,?,?,?,?,'uploading',?,?,?,?,'group',?)").bind(id, user.publisher_id, user.group_id, key, hash, photoWeek(), createdAt, user.user_id, user.par_id, image.bytes.byteLength).run();
  const photo = await db.prepare('SELECT * FROM photos WHERE id=?').bind(id).first();
  if (['deleted', 'deleting'].includes(photo.status)) throw new HttpError(410, 'Esta fotografía se ha borrado y no se puede reenviar.');
  if (photo.publisher_id !== user.publisher_id || photo.group_id !== user.group_id || photo.sha256 !== hash) throw new HttpError(409, 'Este envío corresponde a otra fotografía.');
  if (photo.status !== 'uploading') return json({ id, status: photo.status });
  await env.PHOTOS.put(key, image.bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'image/webp', cacheControl: 'private, no-store' } });
  // Recheck authority after storage. Client-supplied status is never accepted.
  await db.prepare("UPDATE photos SET status=CASE WHEN ?=1 THEN 'published' ELSE 'pending' END,published_at=CASE WHEN ?=1 THEN ? ELSE NULL END WHERE id=? AND status='uploading' AND EXISTS(SELECT 1 FROM group_memberships gm JOIN groups g ON gm.group_id=g.id WHERE gm.user_id=? AND gm.group_id=? AND gm.state='active' AND g.active=1 AND g.operational_state='active')").bind(user.trust, user.trust, createdAt, id, user.user_id, user.group_id).run();
  const final = await db.prepare('SELECT status FROM photos WHERE id=?').bind(id).first();
  if (['deleting', 'deleted'].includes(final.status)) { await env.PHOTOS.delete(key); throw new HttpError(410, 'Esta fotografía se ha borrado.'); }
  if (final.status === 'uploading') { await erasePhoto(env, db, photo); throw new HttpError(403, 'No se puede publicar en este grupo.'); }
  if (final.status === 'published') await addPhotoToCurrentWall(db, user.group_id, id, createdAt);
  return json({ id, status: final.status }, created.meta.changes ? 201 : 200);
}
export async function erasePhoto(env, db, photo, owner) {
  // Withdraw first. If R2 fails, the image stays inaccessible and cleanup retries.
  const withdrawn = await db.prepare("UPDATE photos SET status='deleting',description='' WHERE id=? AND status!='deleted'" + (owner ? ' AND user_id=?' : '')).bind(photo.id, ...(owner ? [owner] : [])).run();
  if (owner && !withdrawn.meta.changes) throw new HttpError(404, 'La fotografía ya no está disponible entre tus fotos.');
  await env.PHOTOS.delete(photo.image_key);
  // Keep only a tombstone/key to prevent upload replay and clean up late writers.
  await db.prepare("UPDATE photos SET status='deleted',publisher_id=NULL,user_id=NULL,par_id=NULL,group_id=NULL,sha256=NULL,description='',week=NULL,published_at=NULL,storage_bytes=0,cleaned_at=? WHERE id=?").bind(now(), photo.id).run();
}
export async function cleanupDeleted(env) {
  if (!env.DB) return;
  const db = env.DB.withSession('first-primary');
  const { results } = await db.prepare("SELECT id,image_key FROM photos WHERE status IN ('deleting','deleted') ORDER BY CASE WHEN status='deleting' THEN 0 ELSE 1 END,COALESCE(cleaned_at,'') LIMIT 100").all();
  for (const photo of results) await erasePhoto(env, db, photo);
  await db.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(Math.floor(Date.now() / 1000)).run();
}
async function adminRoutes(request, env, db, url) {
  const identity = await adminIdentity(request, env);
  const admin = identity ? await ensureAdminPrincipal(db, identity, adminEmails(env)) : null;
  if (url.pathname === '/api/admin/session' && request.method === 'GET') return json({ authenticated: Boolean(admin), email: admin?.email, configured: googleReady(env) });
  if (!admin) throw new HttpError(401, 'Entra con una cuenta de Google autorizada.');
  if (request.method !== 'GET') await rate(env.UPLOAD_LIMITER, `admin:${admin.sub}`);
  if (url.pathname === '/api/admin/waitlist' && request.method === 'GET') {
    const before = url.searchParams.get('before');
    let pair;
    if (before) {
      try { pair = JSON.parse(atob(before)); } catch { throw new HttpError(400, 'La página solicitada no es válida.'); }
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(v => typeof v === 'string' && v.length < 100)) throw new HttpError(400, 'La página solicitada no es válida.');
    }
    const rows = (await db.prepare('SELECT id,email,created_at FROM waitlist' + (pair ? ' WHERE created_at < ? OR (created_at = ? AND id < ?)' : '') + ' ORDER BY created_at DESC,id DESC LIMIT 51').bind(...(pair ? [pair[0], pair[0], pair[1]] : [])).all()).results;
    const entries = rows.slice(0, 50), last = entries.at(-1);
    return json({ entries, next: rows.length > 50 ? btoa(JSON.stringify([last.created_at, last.id])) : null });
  }
  const waitlistItem = /^\/api\/admin\/waitlist\/([a-f0-9-]+)$/.exec(url.pathname);
  if (waitlistItem && request.method === 'DELETE') {
    await db.prepare('DELETE FROM waitlist WHERE id=?').bind(waitlistItem[1]).run();
    return json({ deleted: true });
  }
  if (url.pathname === '/api/admin/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(request, 'photown_admin', '', 0) });
  if (url.pathname === '/api/admin/groups') {
    if (request.method === 'GET') return json({ groups: (await db.prepare('SELECT id,name,active,created_at FROM groups ORDER BY created_at DESC,id DESC').all()).results });
    if (request.method === 'POST') {
      if (!admin.superadmin) throw new HttpError(403, 'Solo superadmin puede crear grupos.');
      const body = await bodyJSON(request);
      if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new HttpError(400, 'Escribe un nombre de grupo de hasta 80 caracteres.');
      const id = crypto.randomUUID(), code = invitationCode();
      await db.prepare('INSERT INTO groups (id,name,invite_hash,created_at) VALUES (?,?,?,?)').bind(id, body.name.trim(), await digest(code), now()).run();
      await db.prepare("INSERT INTO group_memberships (user_id,group_id,par_id,role,state,trust,joined_at) VALUES (?,?,?,'admin','active',0,?)").bind(admin.user_id, id, crypto.randomUUID(), now()).run();
      await createInitialWall(db, id, body.name.trim());
      return json({ id, code }, 201);
    }
  }
  const groupAction = /^\/api\/admin\/groups\/([a-z0-9-]+)\/(invitation|active|photos|publishers|wall)$/.exec(url.pathname);
  if (groupAction) {
    const [, group, action] = groupAction;
    if (!(await db.prepare('SELECT id FROM groups WHERE id=?').bind(group).first())) throw new HttpError(404, 'No se encuentra el grupo.');
    await requireGroupAuthority(db, admin, group, action === 'wall' ? ['admin','moderator'] : ['admin']);
    if (action === 'invitation' && request.method === 'POST') {
      const code = invitationCode();
      await db.prepare('UPDATE groups SET invite_hash=? WHERE id=?').bind(await digest(code), group).run();
      return json({ code });
    }
    if (action === 'active' && request.method === 'POST') {
      const body = await bodyJSON(request);
      if (typeof body?.active !== 'boolean') throw new HttpError(400, 'Estado de grupo no válido.');
      await db.prepare('UPDATE groups SET active=? WHERE id=?').bind(Number(body.active), group).run(); return json({ ok: true });
    }
    if (action === 'wall' && request.method === 'GET') {
      const page = await listPhotos(db, "group_id=? AND status='published'", [group], url);
      page.photos.forEach(photo => { delete photo.publisher_id; });
      return json({ ...page, group: await db.prepare('SELECT id,name FROM groups WHERE id=?').bind(group).first() });
    }
    if (action === 'photos' && request.method === 'GET') return json(await listPhotos(db, "group_id=? AND status IN ('pending','published','hidden')", [group], url));
    if (action === 'publishers' && request.method === 'GET') return json({ publishers: (await db.prepare('SELECT m.publisher_id,m.status,p.created_at,p.last_seen FROM memberships m JOIN publishers p ON p.id=m.publisher_id WHERE m.group_id=? ORDER BY p.created_at LIMIT 200').bind(group).all()).results });
  }
  const photoAction = /^\/api\/admin\/photos\/([a-f0-9-]+)\/(approve|hide|trust|delete)$/.exec(url.pathname);
  if (photoAction && request.method === 'POST') {
    const photo = await db.prepare("SELECT * FROM photos WHERE id=? AND status IN ('pending','published','hidden','deleting')").bind(photoAction[1]).first();
    if (!photo) throw new HttpError(404, 'No se encuentra la fotografía.');
    await requireGroupAuthority(db, admin, photo.group_id, ['admin']);
    const action = photoAction[2];
    if (action === 'delete') await erasePhoto(env, db, photo);
    else {
      const publishedAt = action === 'hide' ? null : (photo.published_at || now());
      const statements = [db.prepare("UPDATE photos SET status=?,published_at=COALESCE(published_at,?) WHERE id=? AND status IN ('pending','published','hidden')").bind(action === 'hide' ? 'hidden' : 'published', publishedAt, photo.id)];
      if (action === 'trust') {
        statements.push(db.prepare("UPDATE group_memberships SET trust=1 WHERE user_id=? AND group_id=? AND state='active'").bind(photo.user_id, photo.group_id));
        statements.push(db.prepare("UPDATE memberships SET status='TRUSTED' WHERE publisher_id=? AND group_id=? AND status!='BLOCKED'").bind(photo.publisher_id, photo.group_id));
      }
      await db.batch(statements);
      if (action !== 'hide') await addPhotoToCurrentWall(db, photo.group_id, photo.id, publishedAt);
    }
    return json({ ok: true });
  }
  const recovery = /^\/api\/admin\/groups\/([a-z0-9-]+)\/recover-identity$/.exec(url.pathname);
  if (recovery && request.method === 'POST') {
    await requireGroupAuthority(db, admin, recovery[1], ['admin']);
    const { source, target } = await bodyJSON(request);
    if (!uuid.test(source || '') || !uuid.test(target || '') || source === target) throw new HttpError(400, 'Selecciona dos identidades diferentes.');
    const members = await db.prepare('SELECT publisher_id FROM memberships WHERE group_id=? AND publisher_id IN (?,?)').bind(recovery[1], source, target).all();
    if (members.results.length !== 2) throw new HttpError(400, 'Las dos identidades deben pertenecer a este grupo.');
    const [sourceUser, targetUser] = await Promise.all([
      db.prepare('SELECT user_id FROM publishers WHERE id=?').bind(source).first(),
      db.prepare('SELECT p.user_id,gm.par_id FROM publishers p JOIN group_memberships gm ON gm.user_id=p.user_id AND gm.group_id=? WHERE p.id=?').bind(recovery[1], target).first()
    ]);
    if (!sourceUser || !targetUser) throw new HttpError(400, 'Las identidades no están preparadas para la recuperación.');
    const result = await db.batch([
      db.prepare("UPDATE memberships SET status='BLOCKED' WHERE group_id=? AND publisher_id=?").bind(recovery[1], source),
      db.prepare("UPDATE group_memberships SET state='blocked',blocked_at=? WHERE group_id=? AND user_id=?").bind(now(), recovery[1], sourceUser.user_id),
      db.prepare("UPDATE photos SET publisher_id=?,user_id=?,par_id=? WHERE group_id=? AND publisher_id=? AND status IN ('pending','published','hidden')").bind(target, targetUser.user_id, targetUser.par_id, recovery[1], source)
    ]);
    return json({ transferred: result[2].meta.changes });
  }
  const memberAction = /^\/api\/admin\/groups\/([a-z0-9-]+)\/publishers\/([a-f0-9-]+)$/.exec(url.pathname);
  if (memberAction && request.method === 'POST') {
    await requireGroupAuthority(db, admin, memberAction[1], ['admin']);
    const body = await bodyJSON(request);
    if (!['MODERATED','TRUSTED','BLOCKED'].includes(body?.status)) throw new HttpError(400, 'Estado no válido.');
    const source = await db.prepare('SELECT user_id FROM publishers WHERE id=?').bind(memberAction[2]).first();
    if (!source) throw new HttpError(404, 'No se encuentra la participación.');
    await db.batch([
      db.prepare('UPDATE memberships SET status=? WHERE group_id=? AND publisher_id=?').bind(body.status, memberAction[1], memberAction[2]),
      db.prepare("UPDATE group_memberships SET state=?,trust=? WHERE group_id=? AND user_id=?").bind(body.status === 'BLOCKED' ? 'blocked' : 'active', body.status === 'TRUSTED' ? 1 : 0, memberAction[1], source.user_id)
    ]); return json({ ok: true });
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
  if (path === '/api/waitlist' && request.method === 'POST') {
    await rate(env.ENTRY_LIMITER, 'waitlist:' + await digest(request.headers.get('CF-Connecting-IP') || 'local'));
    const body = await bodyJSON(request, 1024);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) throw new HttpError(400, 'Introduce un correo electrónico válido.');
    await db.prepare('INSERT OR IGNORE INTO waitlist (id,email,created_at) VALUES (?,?,?)').bind(crypto.randomUUID(), email, now()).run();
    // Duplicate submissions have the same response; never disclose membership.
    return json({ saved: true });
  }
  const user = await participant(request, env, db);
  if (path === '/api/session' && request.method === 'GET') return json({ authenticated: Boolean(user), group: user ? { id: user.group_id, name: user.name } : null, status: user?.status, identity: user?.publisher_id, alias: user?.alias, has_avatar: user ? Boolean(await db.prepare('SELECT 1 FROM profile_avatars WHERE publisher_id=? AND group_id=?').bind(user.publisher_id, user.group_id).first()) : false });
  const avatarMatch = /^\/api\/photo-avatar\/([a-f0-9-]+)$/.exec(path);
  if (avatarMatch && request.method === 'GET') {
    const photo = await db.prepare("SELECT * FROM photos WHERE id=? AND status IN ('pending','published','hidden')").bind(avatarMatch[1]).first();
    const oauth = photo ? await adminIdentity(request, env) : null;
    const principal = oauth ? await ensureAdminPrincipal(db, oauth, adminEmails(env)) : null;
    const administrative = photo && await groupAuthority(db, principal, photo.group_id, ['admin','moderator']);
    const allowed = photo && ((user && (photo.user_id === user.user_id || (photo.group_id === user.group_id && photo.status === 'published'))) || administrative);
    if (!allowed) throw new HttpError(404, 'No se encuentra la imagen de perfil.');
    const avatar = await db.prepare('SELECT image FROM profile_avatars WHERE publisher_id=? AND group_id=?').bind(photo.publisher_id, photo.group_id).first();
    if (!avatar) throw new HttpError(404, 'No hay imagen de perfil.');
    return new Response(new Uint8Array(avatar.image), { headers: { 'Content-Type': 'image/webp' } });
  }
  const imageMatch = /^\/api\/images\/([a-f0-9-]+)$/.exec(path);
  if (imageMatch && request.method === 'GET') {
    const photo = await db.prepare("SELECT * FROM photos WHERE id=? AND status IN ('pending','published','hidden')").bind(imageMatch[1]).first();
    const oauth = photo ? await adminIdentity(request, env) : null;
    const principal = oauth ? await ensureAdminPrincipal(db, oauth, adminEmails(env)) : null;
    const administrative = photo && await groupAuthority(db, principal, photo.group_id, ['admin','moderator']);
    const allowed = photo && ((user && (photo.user_id === user.user_id || (photo.group_id === user.group_id && photo.status === 'published'))) || administrative);
    if (!allowed) throw new HttpError(404, 'No se encuentra la fotografía.');
    const object = await env.PHOTOS.get(photo.image_key);
    if (!object) throw new HttpError(404, 'No se encuentra la fotografía.');
    return new Response(object.body, { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store' } });
  }
  if (!path.startsWith('/api/')) {
    if (path === '/admin' || path === '/admin/wall') return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    if (!user) return new Response(null, { status: 302, headers: { Location: '/enter' } });
    return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
  }
  if (!user) throw new HttpError(401, 'Tu acceso ha caducado. Introduce de nuevo tu invitación.');
  if (path === '/api/profile/avatar') {
    if (request.method === 'GET') {
      const avatar = await db.prepare('SELECT image FROM profile_avatars WHERE publisher_id=? AND group_id=?').bind(user.publisher_id, user.group_id).first();
      if (!avatar) throw new HttpError(404, 'No hay imagen de perfil.');
      return new Response(new Uint8Array(avatar.image), { headers: { 'Content-Type': 'image/webp' } });
    }
    if (['PUT','DELETE'].includes(request.method)) {
      await rate(env.UPLOAD_LIMITER, user.publisher_id);
      if (request.method === 'DELETE') await db.prepare('DELETE FROM profile_avatars WHERE publisher_id=? AND group_id=?').bind(user.publisher_id, user.group_id).run();
      else {
        if (request.headers.get('Content-Type') !== 'image/webp') throw new HttpError(415, 'Formato de imagen no válido.');
        const avatar = sanitizeWebP(await boundedBody(request, 131072));
        if (avatar.width > 512 || avatar.height > 512) throw new HttpError(400, 'La imagen de perfil debe tener como máximo 512 píxeles de lado.');
        await db.prepare('INSERT INTO profile_avatars (publisher_id,group_id,image) VALUES (?,?,?) ON CONFLICT(publisher_id,group_id) DO UPDATE SET image=excluded.image').bind(user.publisher_id, user.group_id, [...avatar.bytes]).run();
      }
      return json({ ok: true });
    }
  }
  const cover = /^\/api\/groups\/([a-z0-9-]+)\/cover$/.exec(path);
  if (cover && request.method === 'GET') {
    const member = await db.prepare("SELECT 1 FROM group_memberships gm JOIN groups g ON g.id=gm.group_id WHERE gm.user_id=? AND g.id=? AND gm.state='active' AND g.active=1").bind(user.user_id, cover[1]).first();
    const photo = member && await db.prepare("SELECT image_key FROM photos WHERE group_id=? AND status='published' ORDER BY created_at DESC,id DESC LIMIT 1").bind(cover[1]).first();
    const object = photo && await env.PHOTOS.get(photo.image_key);
    if (!object) throw new HttpError(404, 'No hay portada disponible.');
    return new Response(object.body, { headers: { 'Content-Type': 'image/webp' } });
  }
  if (path === '/api/groups' && request.method === 'GET') return json({ groups: (await db.prepare(`SELECT g.id,g.name,
    CASE WHEN gm.state='blocked' THEN 'BLOCKED' WHEN gm.trust=1 THEN 'TRUSTED' ELSE 'MODERATED' END AS status,
    EXISTS(SELECT 1 FROM photos WHERE photos.group_id=g.id AND photos.status='published') AS has_cover
    FROM group_memberships gm JOIN groups g ON g.id=gm.group_id
    WHERE gm.user_id=? AND gm.state NOT IN ('blocked','left') AND g.active=1 ORDER BY g.name,g.id`).bind(user.user_id).all()).results });
  if (path === '/api/groups/select' && request.method === 'POST') {
    const { group } = await bodyJSON(request);
    const member = await db.prepare("SELECT g.id,g.name FROM group_memberships gm JOIN groups g ON g.id=gm.group_id WHERE gm.user_id=? AND gm.state NOT IN ('blocked','left') AND g.id=? AND g.active=1").bind(user.user_id, typeof group === 'string' ? group : '').first();
    if (!member) throw new HttpError(403, 'Primero necesitas una invitación para ese grupo.');
    return json({ group: member }, 200, { 'Set-Cookie': cookieHeader(request, 'photown_group', await signToken(env, { publisher: user.publisher_id, group: member.id }, 'participant', 43200), 43200) });
  }
  if (path === '/api/profile' && request.method === 'POST') {
    await rate(env.UPLOAD_LIMITER, user.publisher_id);
    const body = await bodyJSON(request);
    if (typeof body?.alias !== 'string' || body.alias.length > 40 || /[\u0000-\u001f\u007f]/.test(body.alias)) throw new HttpError(400, 'El alias debe tener hasta 40 caracteres y ocupar una sola línea.');
    const alias = body.alias.trim();
    await db.prepare('UPDATE memberships SET alias=? WHERE group_id=? AND publisher_id=?').bind(alias, user.group_id, user.publisher_id).run();
    return json({ alias });
  }
  if (path === '/api/photos' && request.method === 'POST') {
    const destination = request.headers.get('X-Photown-Group');
    if (destination && destination !== user.group_id) throw new HttpError(409, 'La fotografía pertenece al grupo desde el que abriste CAMERA.');
    return upload(request, env, db, user);
  }
  if (path === '/api/library' && request.method === 'GET') return json(await listPhotos(db, "user_id=? AND status!='deleted'", [user.user_id], url, true));
  if (path === '/api/my-photos' && request.method === 'GET') return json(await listPhotos(db, "group_id=? AND publisher_id=? AND status NOT IN ('deleted')", [user.group_id, user.publisher_id], url));
  if (path === '/api/wall' && request.method === 'GET') {
    const page = await listPhotos(db, "group_id=? AND status='published'", [user.group_id], url);
    page.photos.forEach(photo => { delete photo.publisher_id; }); return json(page);
  }
  const own = /^\/api\/(?:my-photos|library)\/([a-f0-9-]+)(\/description|\/download)?$/.exec(path);
  if (own) {
    if (request.method === 'DELETE' && (await db.prepare("SELECT id FROM photos WHERE id=? AND status='deleted'").bind(own[1]).first())) return json({ deleted: true });
    const personal = path.startsWith('/api/library/');
    const photo = await db.prepare('SELECT * FROM photos WHERE id=? AND user_id=?' + (personal ? '' : ' AND group_id=?')).bind(own[1], user.user_id, ...(personal ? [] : [user.group_id])).first();
    if (!photo) throw new HttpError(404, 'No se encuentra esta fotografía entre tus fotos.');
    if (request.method === 'GET' && own[2] === '/download') {
      if (!['pending','published','hidden'].includes(photo.status)) throw new HttpError(404, 'Esta fotografía ya no está disponible.');
      const object = await env.PHOTOS.get(photo.image_key);
      if (!object) throw new HttpError(404, 'Esta fotografía ya no está disponible.');
      return new Response(object.body, { headers: { 'Content-Type': 'image/webp', 'Content-Disposition': `attachment; filename="photown-${photo.id}.webp"`, 'Cache-Control': 'private, no-store' } });
    }
    if (request.method === 'DELETE' && !own[2]) { await erasePhoto(env, db, photo, user.user_id); return json({ deleted: true }); }
    if (request.method === 'POST' && own[2] === '/description') {
      const body = await bodyJSON(request);
      if (typeof body?.description !== 'string' || body.description.length > 500) throw new HttpError(400, 'La descripción debe tener como máximo 500 caracteres.');
      const updated = await db.prepare("UPDATE photos SET description=? WHERE id=? AND user_id=? AND status NOT IN ('deleting','deleted')").bind(body.description.trim(), photo.id, user.user_id).run();
      if (!updated.meta.changes) throw new HttpError(404, 'La fotografía ya no está disponible entre tus fotos.');
      return json({ ok: true });
    }
  }
  throw new HttpError(404, 'Esta operación no está disponible.');
}

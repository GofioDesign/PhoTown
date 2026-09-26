import { digest, HttpError, boundedBody, requireSameOrigin } from './security.js';
import { cookieValue, cookieHeader, randomToken, verifyToken } from './tokens.js';
import { googleStart, googleCallback, googleReady, adminIdentity } from './google-auth.js';
import { sanitizeWebP } from './webp.js';
import { sanitizeImage, imageTypes } from './images.js';
import { identity, requestLogin, verifyLogin, logout, groupCookie, inviteMembers, listInvitations, normalizeEmail } from './accounts.js';
import { photoPublished, photoApproved, reactionAdded, challengeCreated, sendDigests, describe } from './notify.js';
import { mailReady } from './mail.js';

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const now = () => new Date().toISOString();
const MAX_PHOTO = 5 * 1024 * 1024, MAX_THUMB = 300 * 1024, THUMB_EDGE = 720;
export const GRIDS = ['none', 'thirds', 'phi', 'spiral', 'diagonals', 'center'];
export const REACTIONS = ['like', 'light', 'composition', 'idea'];
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
const memberQuery = 'SELECT m.status,m.alias,g.id AS group_id,g.name,g.active FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.publisher_id=? AND g.active=1';
// The account comes from the session cookie. The active group is a preference
// kept in a signed cookie; without it, the first open group is used.
async function participant(request, env, db) {
  const account = await identity(request, db);
  if (!account) return { account: null, user: null };
  const access = await verifyToken(env, cookieValue(request, 'photown_group'), 'participant');
  let member = access?.publisher === account.id && await db.prepare(memberQuery + ' AND g.id=?').bind(account.id, access.group).first();
  if (!member) member = await db.prepare(memberQuery + ' ORDER BY g.name,g.id LIMIT 1').bind(account.id).first();
  return { account, user: member ? { ...member, publisher_id: account.id, email: account.email } : null };
}
function pageCursor(url) {
  const cursor = url.searchParams.get('before');
  if (!cursor) return null;
  let pair; try { pair = JSON.parse(atob(cursor)); } catch { throw new HttpError(400, 'La página solicitada no es válida.'); }
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(v => typeof v === 'string' && v.length < 100)) throw new HttpError(400, 'La página solicitada no es válida.');
  return pair;
}
async function listPhotos(db, where, bindings, url, { library = false, viewer = null } = {}) {
  const pair = pageCursor(url), args = [...bindings];
  let clause = where;
  if (pair) { clause += ' AND (created_at < ? OR (created_at = ? AND id < ?))'; args.push(pair[0], pair[0], pair[1]); }
  const result = await db.prepare(`SELECT id,description,status,week,created_at,publisher_id,content_type,challenge_id,thumb_key IS NOT NULL AS has_thumb,
    ${library ? 'group_id,(SELECT name FROM groups WHERE groups.id=photos.group_id) AS group_name,' : ''}
    (SELECT title FROM challenges WHERE challenges.id=photos.challenge_id) AS challenge_title,
    (SELECT COUNT(*) FROM reactions r WHERE r.photo_id=photos.id) AS reactions,
    ${viewer ? '(SELECT COUNT(*) FROM reactions r WHERE r.photo_id=photos.id AND r.publisher_id=?) AS reacted,' : ''}
    (EXISTS(SELECT 1 FROM profile_avatars a WHERE a.publisher_id=photos.publisher_id AND a.group_id=photos.group_id)) AS has_avatar,
    (SELECT alias FROM memberships WHERE memberships.publisher_id=photos.publisher_id AND memberships.group_id=photos.group_id) AS alias
    FROM photos WHERE ${clause} ORDER BY created_at DESC,id DESC LIMIT 25`).bind(...(viewer ? [viewer] : []), ...args).all();
  const more = result.results.length > 24, photos = result.results.slice(0, 24), last = photos.at(-1);
  return { photos, next: more ? btoa(JSON.stringify([last.created_at, last.id])) : null };
}
const hidePublishers = page => { page.photos.forEach(photo => { delete photo.publisher_id; }); return page; };

// Accepts the original raw body (WebP/JPEG) or multipart with `photo`, an
// optional `thumb` for the wall and an optional `challenge`.
async function readUpload(request) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (imageTypes[type]) return { type, photo: await boundedBody(request, MAX_PHOTO), challenge: request.headers.get('X-Photown-Challenge') };
  if (type !== 'multipart/form-data') throw new HttpError(415, 'Solo se admiten fotografías WebP o JPEG.');
  const bytes = await boundedBody(request, MAX_PHOTO + MAX_THUMB + 16384);
  let form; try { form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('Content-Type') } }).formData(); }
  catch { throw new HttpError(400, 'No se reconoce el envío. Vuelve a fotografiar.'); }
  const photo = form.get('photo'), thumb = form.get('thumb'), challenge = form.get('challenge');
  if (!(photo instanceof Blob) || !imageTypes[photo.type]) throw new HttpError(415, 'Solo se admiten fotografías WebP o JPEG.');
  if (photo.size > MAX_PHOTO) throw new HttpError(413, 'El archivo es demasiado grande.');
  const result = { type: photo.type, photo: new Uint8Array(await photo.arrayBuffer()), challenge: typeof challenge === 'string' ? challenge : null };
  if (thumb instanceof Blob && thumb.size) {
    if (!imageTypes[thumb.type] || thumb.size > MAX_THUMB) throw new HttpError(415, 'La miniatura no es válida.');
    result.thumb = { type: thumb.type, bytes: new Uint8Array(await thumb.arrayBuffer()) };
  }
  return result;
}
async function upload(request, env, db, user) {
  if (user.status === 'BLOCKED') throw new HttpError(403, 'Tu participación está bloqueada. Contacta con la persona que coordina el grupo.');
  await rate(env.UPLOAD_LIMITER, user.publisher_id);
  const id = request.headers.get('Idempotency-Key');
  if (!uuid.test(id || '')) throw new HttpError(400, 'No se reconoce el envío. Vuelve a fotografiar.');
  const received = await readUpload(request);
  const image = sanitizeImage(received.photo, received.type), hash = await digest(image.bytes);
  const thumb = received.thumb && sanitizeImage(received.thumb.bytes, received.thumb.type, THUMB_EDGE);
  let challenge = null;
  if (received.challenge) {
    if (!uuid.test(received.challenge)) throw new HttpError(400, 'El reto no es válido.');
    challenge = await db.prepare('SELECT id FROM challenges WHERE id=? AND group_id=? AND active=1').bind(received.challenge, user.group_id).first();
    if (!challenge) throw new HttpError(409, 'Este reto ya no está abierto. Envía la foto sin reto o elige otro.');
  }
  const extension = imageTypes[received.type];
  const key = `groups/${user.group_id}/photos/${id}.${extension}`;
  const thumbKey = thumb ? `groups/${user.group_id}/thumbs/${id}.${imageTypes[received.thumb.type]}` : null;
  const created = await db.prepare("INSERT OR IGNORE INTO photos (id,publisher_id,group_id,image_key,sha256,status,week,created_at,content_type,thumb_key,challenge_id) VALUES (?,?,?,?,?,'uploading',?,?,?,?,?)")
    .bind(id, user.publisher_id, user.group_id, key, hash, photoWeek(), now(), received.type, thumbKey, challenge?.id ?? null).run();
  const photo = await db.prepare('SELECT * FROM photos WHERE id=?').bind(id).first();
  if (['deleted', 'deleting'].includes(photo.status)) throw new HttpError(410, 'Esta fotografía se ha borrado y no se puede reenviar.');
  if (photo.publisher_id !== user.publisher_id || photo.group_id !== user.group_id || photo.sha256 !== hash) throw new HttpError(409, 'Este envío corresponde a otra fotografía.');
  if (photo.status !== 'uploading') return json({ id, status: photo.status });
  await env.PHOTOS.put(photo.image_key, image.bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: photo.content_type, cacheControl: 'private, no-store' } });
  if (thumb && photo.thumb_key) await env.PHOTOS.put(photo.thumb_key, thumb.bytes, { httpMetadata: { contentType: received.thumb.type, cacheControl: 'private, no-store' } });
  // Recheck authority after storage. Client-supplied status is never accepted.
  await db.prepare("UPDATE photos SET status=CASE WHEN (SELECT status FROM memberships WHERE publisher_id=? AND group_id=?)='TRUSTED' THEN 'published' ELSE 'pending' END WHERE id=? AND status='uploading' AND EXISTS(SELECT 1 FROM memberships m JOIN groups g ON m.group_id=g.id WHERE m.publisher_id=? AND m.group_id=? AND m.status!='BLOCKED' AND g.active=1)").bind(user.publisher_id, user.group_id, id, user.publisher_id, user.group_id).run();
  const final = await db.prepare('SELECT status FROM photos WHERE id=?').bind(id).first();
  if (['deleting', 'deleted'].includes(final.status)) { await env.PHOTOS.delete(photo.image_key); if (photo.thumb_key) await env.PHOTOS.delete(photo.thumb_key); throw new HttpError(410, 'Esta fotografía se ha borrado.'); }
  if (final.status === 'uploading') { await erasePhoto(env, db, photo); throw new HttpError(403, 'No se puede publicar en este grupo.'); }
  if (final.status === 'published') await photoPublished(db, id).run();
  return json({ id, status: final.status }, created.meta.changes ? 201 : 200);
}
export async function erasePhoto(env, db, photo, owner) {
  // Withdraw first. If R2 fails, the image stays inaccessible and cleanup retries.
  const withdrawn = await db.prepare("UPDATE photos SET status='deleting',description='' WHERE id=? AND status!='deleted'" + (owner ? ' AND publisher_id=?' : '')).bind(photo.id, ...(owner ? [owner] : [])).run();
  if (owner && !withdrawn.meta.changes) throw new HttpError(404, 'La fotografía ya no está disponible entre tus fotos.');
  await env.PHOTOS.delete(photo.image_key);
  if (photo.thumb_key) await env.PHOTOS.delete(photo.thumb_key);
  // Keep only a tombstone/key to prevent upload replay and clean up late writers.
  await db.batch([
    db.prepare('DELETE FROM reactions WHERE photo_id=?').bind(photo.id),
    db.prepare('DELETE FROM notifications WHERE photo_id=?').bind(photo.id),
    db.prepare("UPDATE photos SET status='deleted',publisher_id=NULL,group_id=NULL,sha256=NULL,description='',week=NULL,challenge_id=NULL,thumb_key=NULL,cleaned_at=? WHERE id=?").bind(now(), photo.id)
  ]);
}
export async function cleanupDeleted(env) {
  if (!env.DB) return;
  const db = env.DB.withSession('first-primary');
  const { results } = await db.prepare("SELECT id,image_key,thumb_key FROM photos WHERE status IN ('deleting','deleted') ORDER BY CASE WHEN status='deleting' THEN 0 ELSE 1 END,COALESCE(cleaned_at,'') LIMIT 100").all();
  for (const photo of results) await erasePhoto(env, db, photo);
  const seconds = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(seconds),
    db.prepare('DELETE FROM login_tokens WHERE expires_at<?').bind(seconds),
    db.prepare('DELETE FROM sessions WHERE expires_at<?').bind(seconds),
    db.prepare('DELETE FROM notifications WHERE created_at<?').bind(new Date(Date.now() - 90 * 86400000).toISOString())
  ]);
  try { await sendDigests(env, db); } catch (error) { console.error('Digest run failed', error); }
}
function challengeInput(body, partial = false) {
  const values = {};
  if (!partial || 'title' in body) { if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 80) throw new HttpError(400, 'Escribe un título de hasta 80 caracteres.'); values.title = body.title.trim(); }
  if (!partial || 'prompt' in body) { if (typeof (body.prompt ?? '') !== 'string' || (body.prompt ?? '').length > 1000) throw new HttpError(400, 'La propuesta admite hasta 1000 caracteres.'); values.prompt = (body.prompt ?? '').trim(); }
  if (!partial || 'grid' in body) { if (!GRIDS.includes(body.grid ?? 'none')) throw new HttpError(400, 'Guía de composición no válida.'); values.grid = body.grid ?? 'none'; }
  if (!partial || 'ends_at' in body) {
    const end = body.ends_at ?? null;
    if (end !== null && (typeof end !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(end))) throw new HttpError(400, 'Fecha de cierre no válida.');
    values.ends_at = end;
  }
  if (partial && 'active' in body) { if (typeof body.active !== 'boolean') throw new HttpError(400, 'Estado no válido.'); values.active = Number(body.active); }
  return values;
}
async function adminRoutes(request, env, db, url) {
  const admin = await adminIdentity(request, env);
  if (url.pathname === '/api/admin/session' && request.method === 'GET') return json({ authenticated: Boolean(admin), email: admin?.email, configured: googleReady(env), mail: mailReady(env) });
  if (!admin) throw new HttpError(401, 'Entra con una cuenta de Google autorizada.');
  if (request.method !== 'GET') await rate(env.UPLOAD_LIMITER, `admin:${admin.sub}`);
  if (url.pathname === '/api/admin/waitlist' && request.method === 'GET') {
    const pair = pageCursor(url);
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
    if (request.method === 'GET') return json({ groups: (await db.prepare(`SELECT g.id,g.name,g.active,g.created_at,
      (SELECT COUNT(*) FROM photos p WHERE p.group_id=g.id AND p.status='pending') AS pending,
      (SELECT COUNT(*) FROM memberships m WHERE m.group_id=g.id AND m.status!='BLOCKED') AS members,
      (SELECT COUNT(*) FROM challenges c WHERE c.group_id=g.id AND c.active=1) AS challenges
      FROM groups g ORDER BY g.created_at DESC,g.id DESC`).all()).results });
    if (request.method === 'POST') {
      const body = await bodyJSON(request);
      if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new HttpError(400, 'Escribe un nombre de grupo de hasta 80 caracteres.');
      // Access is by email invitation; the legacy invitation hash is a random placeholder.
      const id = crypto.randomUUID();
      await db.prepare('INSERT INTO groups (id,name,invite_hash,created_at) VALUES (?,?,?,?)').bind(id, body.name.trim(), await digest(randomToken()), now()).run();
      return json({ id }, 201);
    }
  }
  const groupAction = /^\/api\/admin\/groups\/([a-z0-9-]+)\/(active|photos|publishers|wall|invitations|challenges)$/.exec(url.pathname);
  if (groupAction) {
    const [, groupId, action] = groupAction;
    const group = await db.prepare('SELECT id,name,active FROM groups WHERE id=?').bind(groupId).first();
    if (!group) throw new HttpError(404, 'No se encuentra el grupo.');
    if (action === 'active' && request.method === 'POST') {
      const body = await bodyJSON(request);
      if (typeof body?.active !== 'boolean') throw new HttpError(400, 'Estado de grupo no válido.');
      await db.prepare('UPDATE groups SET active=? WHERE id=?').bind(Number(body.active), group.id).run(); return json({ ok: true });
    }
    if (action === 'invitations' && request.method === 'GET') return json({ invitations: await listInvitations(db, group.id), mail: mailReady(env) });
    if (action === 'invitations' && request.method === 'POST') {
      const body = await bodyJSON(request, 32768);
      return json({ results: await inviteMembers(request, env, db, admin, group, body?.emails), mail: mailReady(env) });
    }
    if (action === 'invitations' && request.method === 'DELETE') {
      const email = normalizeEmail(url.searchParams.get('email'));
      await db.prepare('DELETE FROM invitations WHERE group_id=? AND email=? AND accepted_at IS NULL').bind(group.id, email).run();
      return json({ deleted: true });
    }
    if (action === 'challenges' && request.method === 'GET') return json({ challenges: (await db.prepare("SELECT c.*,(SELECT COUNT(*) FROM photos p WHERE p.challenge_id=c.id AND p.status IN ('pending','published','hidden')) AS photos FROM challenges c WHERE c.group_id=? ORDER BY c.active DESC,c.created_at DESC").bind(group.id).all()).results });
    if (action === 'challenges' && request.method === 'POST') {
      const values = challengeInput(await bodyJSON(request)), id = crypto.randomUUID();
      await db.prepare('INSERT INTO challenges (id,group_id,title,prompt,grid,ends_at,created_at) VALUES (?,?,?,?,?,?,?)').bind(id, group.id, values.title, values.prompt, values.grid, values.ends_at, now()).run();
      await challengeCreated(db, id).run();
      return json({ id }, 201);
    }
    if (action === 'wall' && request.method === 'GET') {
      const challenge = url.searchParams.get('challenge');
      const page = hidePublishers(await listPhotos(db, "group_id=? AND status='published'" + (challenge ? ' AND challenge_id=?' : ''), challenge ? [group.id, challenge] : [group.id], url));
      return json({ ...page, group: { id: group.id, name: group.name }, challenges: (await db.prepare('SELECT id,title,grid,active FROM challenges WHERE group_id=? ORDER BY active DESC,created_at DESC').bind(group.id).all()).results });
    }
    if (action === 'photos' && request.method === 'GET') {
      const status = url.searchParams.get('status');
      const filter = status === 'pending' ? "group_id=? AND status='pending'" : "group_id=? AND status IN ('pending','published','hidden')";
      return json(await listPhotos(db, filter, [group.id], url));
    }
    if (action === 'publishers' && request.method === 'GET') return json({ publishers: (await db.prepare('SELECT m.publisher_id,m.status,m.alias,p.email,p.created_at,p.last_seen FROM memberships m JOIN publishers p ON p.id=m.publisher_id WHERE m.group_id=? ORDER BY p.email IS NULL,p.email,p.created_at LIMIT 300').bind(group.id).all()).results });
  }
  const challengeAction = /^\/api\/admin\/challenges\/([a-f0-9-]+)$/.exec(url.pathname);
  if (challengeAction && request.method === 'POST') {
    const values = challengeInput(await bodyJSON(request), true), keys = Object.keys(values);
    if (!keys.length) throw new HttpError(400, 'No hay cambios.');
    const updated = await db.prepare(`UPDATE challenges SET ${keys.map(key => `${key}=?`).join(',')} WHERE id=?`).bind(...keys.map(key => values[key]), challengeAction[1]).run();
    if (!updated.meta.changes) throw new HttpError(404, 'No se encuentra el reto.');
    return json({ ok: true });
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
      // First publication only: members and author are told once.
      if (action !== 'hide' && photo.status === 'pending') statements.push(photoPublished(db, photo.id), photoApproved(db, photo.id));
      await db.batch(statements);
    }
    return json({ ok: true });
  }
  const recovery = /^\/api\/admin\/groups\/([a-z0-9-]+)\/recover-identity$/.exec(url.pathname);
  if (recovery && request.method === 'POST') {
    const { source, target } = await bodyJSON(request);
    if (!uuid.test(source || '') || !uuid.test(target || '') || source === target) throw new HttpError(400, 'Selecciona dos identidades diferentes.');
    const members = await db.prepare('SELECT publisher_id FROM memberships WHERE group_id=? AND publisher_id IN (?,?)').bind(recovery[1], source, target).all();
    if (members.results.length !== 2) throw new HttpError(400, 'Las dos identidades deben pertenecer a este grupo.');
    const result = await db.batch([
      db.prepare("UPDATE memberships SET status='BLOCKED' WHERE group_id=? AND publisher_id=?").bind(recovery[1], source),
      db.prepare("UPDATE photos SET publisher_id=? WHERE group_id=? AND publisher_id=? AND status IN ('pending','published','hidden')").bind(target, recovery[1], source)
    ]);
    return json({ transferred: result[1].meta.changes });
  }
  const memberAction = /^\/api\/admin\/groups\/([a-z0-9-]+)\/publishers\/([a-f0-9-]+)$/.exec(url.pathname);
  if (memberAction && request.method === 'POST') {
    const body = await bodyJSON(request);
    if (!['MODERATED','TRUSTED','BLOCKED'].includes(body?.status)) throw new HttpError(400, 'Estado no válido.');
    await db.prepare('UPDATE memberships SET status=? WHERE group_id=? AND publisher_id=?').bind(body.status, memberAction[1], memberAction[2]).run(); return json({ ok: true });
  }
  throw new HttpError(404, 'Esta operación no está disponible.');
}
// A photograph is visible to its owner, to members of its group once
// published, and to administrators.
async function visiblePhoto(request, env, db, account, id) {
  const photo = await db.prepare("SELECT * FROM photos WHERE id=? AND status IN ('pending','published','hidden')").bind(id).first();
  if (!photo) return null;
  // Closing a group withdraws access immediately, also for its authors.
  if (account && photo.publisher_id === account.id && await db.prepare('SELECT 1 FROM groups WHERE id=? AND active=1').bind(photo.group_id).first()) return photo;
  if (account && photo.status === 'published' && await db.prepare("SELECT 1 FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.publisher_id=? AND m.group_id=? AND m.status!='BLOCKED' AND g.active=1").bind(account.id, photo.group_id).first()) return photo;
  return (await adminIdentity(request, env)) ? photo : null;
}
async function reactionSummary(db, photoId, viewer) {
  const rows = (await db.prepare('SELECT kind,COUNT(*) AS n,SUM(publisher_id=?) AS mine FROM reactions WHERE photo_id=? GROUP BY kind').bind(viewer || '', photoId).all()).results;
  return { counts: Object.fromEntries(REACTIONS.map(kind => [kind, rows.find(row => row.kind === kind)?.n || 0])), mine: rows.filter(row => row.mine > 0).map(row => row.kind) };
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
  if (path === '/api/enter') throw new HttpError(410, 'Ahora se entra con tu correo electrónico. Pide tu enlace de acceso.');
  if (path === '/api/login' && request.method === 'POST') {
    await rate(env.ENTRY_LIMITER, 'login:' + await digest(request.headers.get('CF-Connecting-IP') || 'local'));
    return json(await requestLogin(request, env, db, await bodyJSON(request, 1024)));
  }
  if (path === '/api/login/verify' && request.method === 'POST') {
    await rate(env.ENTRY_LIMITER, 'verify:' + await digest(request.headers.get('CF-Connecting-IP') || 'local'));
    return verifyLogin(request, env, db, await bodyJSON(request, 1024));
  }
  if (path === '/api/logout' && request.method === 'POST') return logout(request, db);
  if (path === '/api/waitlist' && request.method === 'POST') {
    await rate(env.ENTRY_LIMITER, 'waitlist:' + await digest(request.headers.get('CF-Connecting-IP') || 'local'));
    const body = await bodyJSON(request, 1024);
    const email = normalizeEmail(body?.email);
    await db.prepare('INSERT OR IGNORE INTO waitlist (id,email,created_at) VALUES (?,?,?)').bind(crypto.randomUUID(), email, now()).run();
    // Duplicate submissions have the same response; never disclose membership.
    return json({ saved: true });
  }
  const { account, user } = await participant(request, env, db);
  if (path === '/api/session' && request.method === 'GET') {
    if (!account) return json({ authenticated: false, group: null });
    const unread = await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE publisher_id=? AND read_at IS NULL').bind(account.id).first();
    return json({ authenticated: true, email: account.email, digest: Boolean(account.email_digest), identity: account.id, unread: unread.n,
      group: user ? { id: user.group_id, name: user.name } : null, status: user?.status, alias: user?.alias,
      has_avatar: user ? Boolean(await db.prepare('SELECT 1 FROM profile_avatars WHERE publisher_id=? AND group_id=?').bind(user.publisher_id, user.group_id).first()) : false });
  }
  const avatarMatch = /^\/api\/photo-avatar\/([a-f0-9-]+)$/.exec(path);
  if (avatarMatch && request.method === 'GET') {
    const photo = await visiblePhoto(request, env, db, account, avatarMatch[1]);
    if (!photo) throw new HttpError(404, 'No se encuentra la imagen de perfil.');
    const avatar = await db.prepare('SELECT image FROM profile_avatars WHERE publisher_id=? AND group_id=?').bind(photo.publisher_id, photo.group_id).first();
    if (!avatar) throw new HttpError(404, 'No hay imagen de perfil.');
    return new Response(new Uint8Array(avatar.image), { headers: { 'Content-Type': 'image/webp' } });
  }
  const imageMatch = /^\/api\/images\/([a-f0-9-]+)$/.exec(path);
  if (imageMatch && request.method === 'GET') {
    const photo = await visiblePhoto(request, env, db, account, imageMatch[1]);
    if (!photo) throw new HttpError(404, 'No se encuentra la fotografía.');
    const small = url.searchParams.get('size') === 'thumb' && photo.thumb_key;
    const object = await env.PHOTOS.get(small ? photo.thumb_key : photo.image_key) || (small ? await env.PHOTOS.get(photo.image_key) : null);
    if (!object) throw new HttpError(404, 'No se encuentra la fotografía.');
    // Identifiers are immutable: the browser may keep its private copy briefly.
    return new Response(object.body, { headers: { 'Content-Type': small ? (photo.thumb_key.endsWith('.jpg') ? 'image/jpeg' : 'image/webp') : photo.content_type, 'Cache-Control': 'private, max-age=3600' } });
  }
  if (!path.startsWith('/api/')) {
    if (path === '/admin' || path === '/admin/wall') return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    if (!account) return new Response(null, { status: 302, headers: { Location: '/login' } });
    return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
  }
  if (!account) throw new HttpError(401, 'Tu sesión ha caducado. Vuelve a entrar con tu correo.');
  if (path === '/api/preferences' && request.method === 'POST') {
    const body = await bodyJSON(request);
    if (typeof body?.digest !== 'boolean') throw new HttpError(400, 'Preferencia no válida.');
    await db.prepare('UPDATE publishers SET email_digest=? WHERE id=?').bind(Number(body.digest), account.id).run();
    return json({ digest: body.digest });
  }
  if (path === '/api/notifications' && request.method === 'GET') {
    const items = (await db.prepare(`SELECT n.id,n.kind,n.photo_id,n.challenge_id,n.group_id,n.actor,n.detail,n.created_at,n.read_at,g.name AS group_name,c.title AS challenge_title
      FROM notifications n LEFT JOIN groups g ON g.id=n.group_id LEFT JOIN challenges c ON c.id=n.challenge_id
      WHERE n.publisher_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT 60`).bind(account.id).all()).results;
    return json({ notifications: items.map(item => ({ ...item, text: describe(item) })) });
  }
  if (path === '/api/notifications/read' && request.method === 'POST') {
    await db.prepare('UPDATE notifications SET read_at=? WHERE publisher_id=? AND read_at IS NULL').bind(now(), account.id).run();
    return json({ ok: true });
  }
  if (path === '/api/groups' && request.method === 'GET') return json({ groups: (await db.prepare(`SELECT g.id,g.name,m.status,EXISTS(SELECT 1 FROM photos WHERE photos.group_id=g.id AND photos.status='published') AS has_cover FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.publisher_id=? AND g.active=1 ORDER BY g.name,g.id`).bind(account.id).all()).results });
  if (path === '/api/groups/select' && request.method === 'POST') {
    const { group } = await bodyJSON(request);
    const member = await db.prepare('SELECT g.id,g.name FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.publisher_id=? AND g.id=? AND g.active=1').bind(account.id, typeof group === 'string' ? group : '').first();
    if (!member) throw new HttpError(403, 'Primero necesitas una invitación para ese grupo.');
    return json({ group: member }, 200, { 'Set-Cookie': await groupCookie(request, env, account.id, member.id) });
  }
  if (path === '/api/library' && request.method === 'GET') return json(await listPhotos(db, "publisher_id=? AND status!='deleted' AND group_id IN (SELECT id FROM groups WHERE active=1)", [account.id], url, { library: true }));
  const reactionMatch = /^\/api\/photos\/([a-f0-9-]+)\/reactions$/.exec(path);
  if (reactionMatch) {
    const photo = await visiblePhoto(request, env, db, account, reactionMatch[1]);
    if (!photo) throw new HttpError(404, 'No se encuentra la fotografía.');
    if (request.method === 'POST') {
      if (photo.status !== 'published') throw new HttpError(409, 'Solo se puede reaccionar a fotos del muro.');
      await rate(env.UPLOAD_LIMITER, 'react:' + account.id);
      const body = await bodyJSON(request);
      if (!REACTIONS.includes(body?.kind) || typeof body.active !== 'boolean') throw new HttpError(400, 'Reacción no válida.');
      if (body.active) {
        const added = await db.prepare('INSERT OR IGNORE INTO reactions (photo_id,publisher_id,kind,created_at) VALUES (?,?,?,?)').bind(photo.id, account.id, body.kind, now()).run();
        if (added.meta.changes) await reactionAdded(db, photo.id, account.id, body.kind).run();
      } else await db.prepare('DELETE FROM reactions WHERE photo_id=? AND publisher_id=? AND kind=?').bind(photo.id, account.id, body.kind).run();
    } else if (request.method !== 'GET') throw new HttpError(405, 'Método no permitido.');
    return json(await reactionSummary(db, photo.id, account.id));
  }
  const own = /^\/api\/(?:my-photos|library)\/([a-f0-9-]+)(\/description|\/download)?$/.exec(path);
  if (own) {
    if (request.method === 'DELETE' && (await db.prepare("SELECT id FROM photos WHERE id=? AND status='deleted'").bind(own[1]).first())) return json({ deleted: true });
    const photo = await db.prepare('SELECT * FROM photos WHERE id=? AND publisher_id=?').bind(own[1], account.id).first();
    if (!photo) throw new HttpError(404, 'No se encuentra esta fotografía entre tus fotos.');
    if (request.method === 'GET' && own[2] === '/download') {
      if (!['pending','published','hidden'].includes(photo.status)) throw new HttpError(404, 'Esta fotografía ya no está disponible.');
      const object = await env.PHOTOS.get(photo.image_key);
      if (!object) throw new HttpError(404, 'Esta fotografía ya no está disponible.');
      return new Response(object.body, { headers: { 'Content-Type': photo.content_type, 'Content-Disposition': `attachment; filename="photown-${photo.id}.${imageTypes[photo.content_type]}"`, 'Cache-Control': 'private, no-store' } });
    }
    if (request.method === 'DELETE' && !own[2]) { await erasePhoto(env, db, photo, account.id); return json({ deleted: true }); }
    if (request.method === 'POST' && own[2] === '/description') {
      const body = await bodyJSON(request);
      if (typeof body?.description !== 'string' || body.description.length > 500) throw new HttpError(400, 'La descripción debe tener como máximo 500 caracteres.');
      const updated = await db.prepare("UPDATE photos SET description=? WHERE id=? AND publisher_id=? AND status NOT IN ('deleting','deleted')").bind(body.description.trim(), photo.id, account.id).run();
      if (!updated.meta.changes) throw new HttpError(404, 'La fotografía ya no está disponible entre tus fotos.');
      return json({ ok: true });
    }
  }
  // Everything below works inside the active group.
  if (!user) throw new HttpError(409, 'Todavía no perteneces a ningún grupo. Pide una invitación a quien coordina PhoTown.');
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
    const member = await db.prepare('SELECT 1 FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.publisher_id=? AND g.id=? AND g.active=1').bind(user.publisher_id, cover[1]).first();
    const photo = member && await db.prepare("SELECT image_key,thumb_key,content_type FROM photos WHERE group_id=? AND status='published' ORDER BY created_at DESC,id DESC LIMIT 1").bind(cover[1]).first();
    const object = photo && await env.PHOTOS.get(photo.thumb_key || photo.image_key);
    if (!object) throw new HttpError(404, 'No hay portada disponible.');
    return new Response(object.body, { headers: { 'Content-Type': photo.thumb_key?.endsWith('.jpg') || (!photo.thumb_key && photo.content_type === 'image/jpeg') ? 'image/jpeg' : 'image/webp' } });
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
    if (!destination || destination === user.group_id) return upload(request, env, db, user);
    const member = await db.prepare('SELECT m.status,g.id AS group_id FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.publisher_id=? AND g.id=? AND g.active=1').bind(user.publisher_id, destination).first();
    if (!member) throw new HttpError(403, 'No puedes enviar a este grupo. Comprueba tu invitación.');
    return upload(request, env, db, { ...member, publisher_id: user.publisher_id });
  }
  if (path === '/api/my-photos' && request.method === 'GET') return json(await listPhotos(db, "group_id=? AND publisher_id=? AND status NOT IN ('deleted')", [user.group_id, user.publisher_id], url));
  if (path === '/api/wall' && request.method === 'GET') {
    const challenge = url.searchParams.get('challenge');
    return json(hidePublishers(await listPhotos(db, "group_id=? AND status='published'" + (challenge ? ' AND challenge_id=?' : ''), challenge ? [user.group_id, challenge] : [user.group_id], url, { viewer: user.publisher_id })));
  }
  if (path === '/api/challenges' && request.method === 'GET') {
    return json({ challenges: (await db.prepare(`SELECT c.id,c.title,c.prompt,c.grid,c.ends_at,c.active,c.created_at,
      (SELECT COUNT(*) FROM photos p WHERE p.challenge_id=c.id AND p.status='published') AS photos,
      (SELECT COUNT(*) FROM photos p WHERE p.challenge_id=c.id AND p.publisher_id=? AND p.status IN ('pending','published','hidden')) AS mine
      FROM challenges c WHERE c.group_id=? ORDER BY c.active DESC,c.created_at DESC LIMIT 100`).bind(user.publisher_id, user.group_id).all()).results });
  }
  throw new HttpError(404, 'Esta operación no está disponible.');
}

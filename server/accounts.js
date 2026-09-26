import { digest, HttpError } from './security.js';
import { cookieValue, cookieHeader, randomToken, signToken } from './tokens.js';
import { adminEmails } from './google-auth.js';
import { sendMail, layout } from './mail.js';

const now = () => new Date().toISOString();
const seconds = () => Math.floor(Date.now() / 1000);
const SESSION_SECONDS = 365 * 24 * 60 * 60;
const LOGIN_SECONDS = 20 * 60;
const INVITATION_SECONDS = 7 * 24 * 60 * 60;
const emailPattern = /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !emailPattern.test(email)) throw new HttpError(400, 'Introduce un correo electrónico válido.');
  return email;
}

// Sessions are per device (table `sessions`). Identities created before email
// accounts keep their single legacy token in `publishers.token_hash`.
export async function identity(request, db) {
  const token = cookieValue(request, 'photown_publisher');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await digest(token);
  return (await db.prepare('SELECT p.id,p.email,p.email_digest FROM sessions s JOIN publishers p ON p.id=s.publisher_id WHERE s.token_hash=? AND s.expires_at>?').bind(hash, seconds()).first())
    || db.prepare('SELECT id,email,email_digest FROM publishers WHERE token_hash=?').bind(hash).first();
}

const codeHash = (env, email, code) => digest(`${env.SESSION_SECRET}:${email}:${code}`);
function sixDigits() {
  const values = crypto.getRandomValues(new Uint32Array(1));
  return String(values[0] % 1000000).padStart(6, '0');
}
async function createLogin(env, db, email, lifetime) {
  const token = randomToken(), code = sixDigits();
  await db.prepare('INSERT INTO login_tokens (token_hash,email,code_hash,created_at,expires_at) VALUES (?,?,?,?,?)').bind(await digest(token), email, await codeHash(env, email, code), seconds(), seconds() + lifetime).run();
  return { token, code };
}
const loginLink = (origin, token) => `${origin}/login?token=${token}`;
// Local development only: with DEV_LOGIN_LINKS=true on localhost the API also
// returns the sign-in link so automated tests can follow it without a mailbox.
const devLinks = (env, request) => env.DEV_LOGIN_LINKS === 'true' && ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname);
const spacedCode = code => `${code.slice(0, 3)} ${code.slice(3)}`;

export async function requestLogin(request, env, db, body) {
  const origin = new URL(request.url).origin;
  const email = normalizeEmail(body?.email);
  const known = await db.prepare('SELECT 1 FROM publishers WHERE email=? UNION SELECT 1 FROM invitations WHERE email=? LIMIT 1').bind(email, email).first();
  const response = { sent: true };
  if (!known && !adminEmails(env).includes(email)) {
    // Same answer for everyone: do not reveal who has an account. Unknown
    // addresses go to the waiting list the administrators already review.
    await db.prepare('INSERT OR IGNORE INTO waitlist (id,email,created_at) VALUES (?,?,?)').bind(crypto.randomUUID(), email, now()).run();
    return response;
  }
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE email=? AND created_at>?').bind(email, seconds() - 600).first();
  if (recent.n >= 3) return response; // quietly limit repeated requests
  await db.prepare('DELETE FROM login_tokens WHERE expires_at<?').bind(seconds()).run();
  const { token, code } = await createLogin(env, db, email, LOGIN_SECONDS);
  const message = layout({
    title: 'Tu acceso a PhoTown',
    paragraphs: ['Pulsa el botón para entrar. No necesitas contraseña.', `También puedes escribir este código en PhoTown: ${spacedCode(code)}`, 'El enlace y el código caducan en 20 minutos y solo sirven una vez.'],
    action: 'Entrar en PhoTown', link: loginLink(origin, token),
    footer: 'Si no has pedido este correo, puedes ignorarlo: nadie podrá entrar sin él.'
  });
  const delivered = await sendMail(env, { to: email, subject: `Tu código de PhoTown: ${spacedCode(code)}`, ...message });
  // Local development without an email binding shows the link on screen.
  if ((!delivered && ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname)) || devLinks(env, request)) Object.assign(response, { dev_link: loginLink(origin, token), dev_code: code });
  return response;
}

async function consume(env, db, body) {
  if (typeof body?.token === 'string' && /^[a-f0-9]{64}$/.test(body.token)) {
    return db.prepare('DELETE FROM login_tokens WHERE token_hash=? AND expires_at>? AND attempts<5 RETURNING email').bind(await digest(body.token), seconds()).first();
  }
  if (typeof body?.code === 'string') {
    const email = normalizeEmail(body.email), code = body.code.replace(/\D/g, '');
    if (code.length !== 6) throw new HttpError(400, 'El código tiene 6 números.');
    const row = await db.prepare('DELETE FROM login_tokens WHERE email=? AND code_hash=? AND expires_at>? AND attempts<5 RETURNING email').bind(email, await codeHash(env, email, code), seconds()).first();
    if (!row) await db.prepare('UPDATE login_tokens SET attempts=attempts+1 WHERE email=?').bind(email).run();
    return row;
  }
  return null;
}

export async function verifyLogin(request, env, db, body) {
  const row = await consume(env, db, body);
  if (!row) throw new HttpError(401, 'El enlace o el código no es válido o ha caducado. Pide uno nuevo.');
  const email = row.email;
  let publisher = await db.prepare('SELECT id FROM publishers WHERE email=?').bind(email).first();
  if (!publisher) {
    // An identity from the anonymous invitation era keeps its photos by claiming the address.
    const current = await identity(request, db);
    if (current && !current.email) {
      const claimed = await db.prepare('UPDATE publishers SET email=? WHERE id=? AND email IS NULL').bind(email, current.id).run();
      if (claimed.meta.changes) publisher = { id: current.id };
    }
  }
  if (!publisher) {
    publisher = { id: crypto.randomUUID() };
    await db.prepare('INSERT INTO publishers (id,token_hash,created_at,last_seen,email) VALUES (?,?,?,?,?)').bind(publisher.id, await digest(randomToken()), now(), now(), email).run();
  }
  const session = randomToken();
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO memberships (publisher_id,group_id) SELECT ?,i.group_id FROM invitations i JOIN groups g ON g.id=i.group_id WHERE i.email=? AND g.active=1').bind(publisher.id, email),
    db.prepare('UPDATE invitations SET accepted_at=COALESCE(accepted_at,?) WHERE email=?').bind(now(), email),
    db.prepare('INSERT INTO sessions (token_hash,publisher_id,created_at,expires_at) VALUES (?,?,?,?)').bind(await digest(session), publisher.id, now(), seconds() + SESSION_SECONDS),
    db.prepare('UPDATE publishers SET last_seen=? WHERE id=?').bind(now(), publisher.id)
  ]);
  const headers = new Headers();
  headers.append('Set-Cookie', cookieHeader(request, 'photown_publisher', session, SESSION_SECONDS));
  const group = await db.prepare('SELECT g.id,g.name FROM memberships m JOIN groups g ON g.id=m.group_id WHERE m.publisher_id=? AND g.active=1 ORDER BY g.name,g.id LIMIT 1').bind(publisher.id).first();
  if (group) headers.append('Set-Cookie', await groupCookie(request, env, publisher.id, group.id));
  return Response.json({ authenticated: true, group }, { headers });
}

export async function groupCookie(request, env, publisher, group) {
  return cookieHeader(request, 'photown_group', await signToken(env, { publisher, group }, 'participant', SESSION_SECONDS), SESSION_SECONDS);
}

export async function logout(request, db) {
  const token = cookieValue(request, 'photown_publisher');
  if (token && /^[a-f0-9]{64}$/.test(token)) await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
  const headers = new Headers();
  headers.append('Set-Cookie', cookieHeader(request, 'photown_publisher', '', 0));
  headers.append('Set-Cookie', cookieHeader(request, 'photown_group', '', 0));
  return Response.json({ ok: true }, { headers });
}

// Administrators invite by email. Each invitation carries a week-long sign-in
// link; existing accounts join the group immediately.
export async function inviteMembers(request, env, db, admin, group, list) {
  if (!Array.isArray(list) || !list.length || list.length > 50) throw new HttpError(400, 'Escribe entre 1 y 50 correos.');
  const emails = [...new Set(list.map(normalizeEmail))];
  const origin = new URL(request.url).origin, results = [];
  for (const email of emails) {
    await db.prepare('INSERT INTO invitations (group_id,email,invited_by,created_at) VALUES (?,?,?,?) ON CONFLICT(group_id,email) DO UPDATE SET invited_by=excluded.invited_by').bind(group.id, email, admin.email, now()).run();
    const existing = await db.prepare('SELECT id FROM publishers WHERE email=?').bind(email).first();
    if (existing) {
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO memberships (publisher_id,group_id) VALUES (?,?)').bind(existing.id, group.id),
        db.prepare('UPDATE invitations SET accepted_at=COALESCE(accepted_at,?) WHERE group_id=? AND email=?').bind(now(), group.id, email)
      ]);
    }
    const { token, code } = await createLogin(env, db, email, INVITATION_SECONDS);
    const message = layout({
      title: `Te invitan a «${group.name}» en PhoTown`,
      paragraphs: ['PhoTown es un diario fotográfico compartido: fotografiamos en blanco y negro y después miramos las fotos juntos.', 'Entra con este botón. No necesitas contraseña: cada vez que quieras volver, te enviaremos un enlace a este correo.', `Código alternativo: ${spacedCode(code)} (válido 7 días).`],
      action: 'Aceptar la invitación', link: loginLink(origin, token),
      footer: 'Si no esperabas esta invitación, ignora este correo.'
    });
    let sent = false;
    try { sent = await sendMail(env, { to: email, subject: `Invitación a ${group.name} · PhoTown`, ...message }); }
    catch (error) { console.error('Invitation email failed', error); }
    if (sent) await db.prepare('UPDATE invitations SET sent_at=? WHERE group_id=? AND email=?').bind(now(), group.id, email).run();
    results.push({ email, sent, member: Boolean(existing), ...(devLinks(env, request) ? { dev_link: loginLink(origin, token), dev_code: code } : {}) });
  }
  return results;
}

export async function listInvitations(db, groupId) {
  return (await db.prepare('SELECT email,invited_by,created_at,sent_at,accepted_at FROM invitations WHERE group_id=? ORDER BY accepted_at IS NOT NULL,created_at DESC LIMIT 300').bind(groupId).all()).results;
}

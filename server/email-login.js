import { digest, HttpError } from './security.js';
import { cookieHeader, randomToken, signToken } from './tokens.js';
import { canonicalEmail } from './identity.js';
import { sendMail, layout } from './mail.js';

// Sign-in by email. A participant first links an address from YO while signed in
// on their device; afterwards that address opens the same USER on any device.
const seconds = () => Math.floor(Date.now() / 1000);
const now = () => new Date().toISOString();
const TOKEN_SECONDS = 20 * 60;
export const DEVICE_SECONDS = 365 * 24 * 60 * 60;
const emailPattern = /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const localHosts = ['localhost', '127.0.0.1'];

export function readEmail(value) {
  const display = typeof value === 'string' ? value.trim() : '';
  if (display.length > 254 || !emailPattern.test(display.toLowerCase())) throw new HttpError(400, 'Introduce un correo electrónico válido.');
  return { email: canonicalEmail(display), display };
}
const codeHash = (env, purpose, email, code) => digest(`${env.SESSION_SECRET}:${purpose}:${email}:${code}`);
function sixDigits() {
  const ceiling = Math.floor(2 ** 32 / 1e6) * 1e6;
  for (;;) { const [value] = crypto.getRandomValues(new Uint32Array(1)); if (value < ceiling) return String(value % 1e6).padStart(6, '0'); }
}
const spaced = code => `${code.slice(0, 3)} ${code.slice(3)}`;
// Automated browser tests only: never active outside localhost.
const devLinks = (env, request) => env.DEV_LOGIN_LINKS === 'true' && localHosts.includes(new URL(request.url).hostname);

async function issue(request, env, db, { purpose, email, display, userId }) {
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE email=? AND created_at>?').bind(email, seconds() - 600).first();
  if (recent.n >= 3) return {}; // quietly limit repeated requests to one address
  await db.prepare('DELETE FROM login_tokens WHERE expires_at<?').bind(seconds()).run();
  const token = randomToken(), code = sixDigits();
  await db.prepare('INSERT INTO login_tokens (token_hash,purpose,email,display_email,user_id,code_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(await digest(token), purpose, email, display, userId ?? null, await codeHash(env, purpose, email, code), seconds(), seconds() + TOKEN_SECONDS).run();
  const link = `${new URL(request.url).origin}/login?token=${token}`;
  const message = purpose === 'link'
    ? layout({ title: 'Confirma tu correo en PhoTown', paragraphs: ['Abre el enlace en el mismo navegador donde lo pediste para vincular este correo con tus fotografías.', `También puedes escribir este código en PhoTown: ${spaced(code)}`, 'El enlace y el código caducan en 20 minutos y solo sirven una vez.'], action: 'Vincular mi correo', link, footer: 'Si no has pedido este correo, puedes ignorarlo.' })
    : layout({ title: 'Tu acceso a PhoTown', paragraphs: ['Pulsa el botón para entrar. No necesitas contraseña.', `También puedes escribir este código en PhoTown: ${spaced(code)}`, 'El enlace y el código caducan en 20 minutos y solo sirven una vez.'], action: 'Entrar en PhoTown', link, footer: 'Si no has pedido este correo, puedes ignorarlo: nadie podrá entrar sin él.' });
  const subject = purpose === 'link' ? `Confirma tu correo en PhoTown: ${spaced(code)}` : `Tu código de PhoTown: ${spaced(code)}`;
  let delivered = false;
  try { delivered = await sendMail(env, { to: display, subject, ...message }); }
  catch (error) { console.error('Email delivery failed', error); }
  if (!delivered && !devLinks(env, request)) throw new HttpError(503, 'No hemos podido enviar el correo. Vuelve a intentarlo en unos minutos.');
  return devLinks(env, request) ? { dev_link: link, dev_code: code } : {};
}

// Requested from YO by a signed-in participant.
export async function requestEmailLink(request, env, db, userId, body) {
  const { email, display } = readEmail(body?.email);
  const current = await db.prepare("SELECT email FROM identity_providers WHERE provider='email' AND user_id=?").bind(userId).first();
  if (current) throw new HttpError(409, current.email === email ? 'Este correo ya está vinculado a tu cuenta.' : 'Ya tienes otro correo vinculado.');
  return { sent: true, ...(await issue(request, env, db, { purpose: 'link', email, display, userId })) };
}

// Requested from the sign-in page. The answer never reveals whether an address is linked.
export async function requestLogin(request, env, db, body) {
  const { email, display } = readEmail(body?.email);
  const linked = await db.prepare("SELECT 1 FROM identity_providers WHERE provider='email' AND email=?").bind(email).first();
  if (!linked) return { sent: true };
  return { sent: true, ...(await issue(request, env, db, { purpose: 'login', email, display })) };
}

async function consume(env, db, body, currentUserId) {
  if (typeof body?.token === 'string') {
    if (!/^[a-f0-9]{64}$/.test(body.token)) return null;
    const hash = await digest(body.token);
    const row = await db.prepare('SELECT purpose,user_id FROM login_tokens WHERE token_hash=? AND expires_at>? AND attempts<5').bind(hash, seconds()).first();
    // A link confirmation only counts in the browser that asked for it; keep the token for that browser.
    if (row?.purpose === 'link' && row.user_id !== currentUserId) throw new HttpError(403, 'Abre el enlace en el mismo navegador donde pediste vincular tu correo.');
    return db.prepare('DELETE FROM login_tokens WHERE token_hash=? AND expires_at>? AND attempts<5 RETURNING purpose,email,display_email,user_id').bind(hash, seconds()).first();
  }
  if (typeof body?.code === 'string' && ['link', 'login'].includes(body?.purpose)) {
    const { email } = readEmail(body.email), code = body.code.replace(/\D/g, '');
    if (code.length !== 6) throw new HttpError(400, 'El código tiene 6 números.');
    if (body.purpose === 'link' && !currentUserId) return null;
    const row = await db.prepare(`DELETE FROM login_tokens WHERE email=? AND purpose=? AND code_hash=? AND expires_at>? AND attempts<5${body.purpose === 'link' ? ' AND user_id=?' : ''}
      RETURNING purpose,email,display_email,user_id`).bind(email, body.purpose, await codeHash(env, body.purpose, email, code), seconds(), ...(body.purpose === 'link' ? [currentUserId] : [])).first();
    if (!row) await db.prepare('UPDATE login_tokens SET attempts=attempts+1 WHERE email=? AND purpose=?').bind(email, body.purpose).run();
    return row;
  }
  return null;
}

export async function verifyEmail(request, env, db, body, publisher) {
  const row = await consume(env, db, body, publisher?.user_id);
  if (!row) throw new HttpError(401, 'El enlace o el código no es válido o ha caducado. Pide uno nuevo.');
  if (row.purpose === 'link') {
    const owner = await db.prepare("SELECT user_id FROM identity_providers WHERE provider='email' AND email=?").bind(row.email).first();
    if (owner && owner.user_id !== row.user_id) throw new HttpError(409, 'Ese correo ya está vinculado a otra cuenta de PhoTown. No se ha cambiado nada.');
    if (!owner) {
      const other = await db.prepare("SELECT 1 FROM identity_providers WHERE provider='email' AND user_id=?").bind(row.user_id).first();
      if (other) throw new HttpError(409, 'Ya tienes otro correo vinculado.');
      try {
        await db.prepare("INSERT INTO identity_providers (id,user_id,provider,subject,email,verified_email,created_at) VALUES (?,?,'email',?,?,?,?)")
          .bind(crypto.randomUUID(), row.user_id, row.email, row.email, row.display_email, now()).run();
      } catch (error) {
        if (/UNIQUE/.test(String(error?.message))) throw new HttpError(409, 'Ese correo ya está vinculado a otra cuenta de PhoTown. No se ha cambiado nada.');
        throw error;
      }
    }
    return Response.json({ purpose: 'link', linked: true, email: row.display_email });
  }
  const linked = await db.prepare("SELECT user_id FROM identity_providers WHERE provider='email' AND email=?").bind(row.email).first();
  const target = linked && await db.prepare('SELECT id FROM publishers WHERE user_id=? ORDER BY last_seen DESC LIMIT 1').bind(linked.user_id).first();
  if (!target) throw new HttpError(401, 'El enlace o el código no es válido o ha caducado. Pide uno nuevo.');
  const session = randomToken();
  await db.batch([
    db.prepare('DELETE FROM device_sessions WHERE expires_at<?').bind(seconds()),
    db.prepare('INSERT INTO device_sessions (token_hash,publisher_id,created_at,expires_at) VALUES (?,?,?,?)').bind(await digest(session), target.id, seconds(), seconds() + DEVICE_SECONDS),
    db.prepare('UPDATE publishers SET last_seen=? WHERE id=?').bind(now(), target.id)
  ]);
  const headers = new Headers();
  headers.append('Set-Cookie', cookieHeader(request, 'photown_publisher', session, DEVICE_SECONDS));
  const group = await db.prepare(`SELECT g.id,g.name FROM memberships m JOIN groups g ON g.id=m.group_id
    JOIN group_memberships gm ON gm.user_id=? AND gm.group_id=g.id
    WHERE m.publisher_id=? AND g.active=1 AND gm.state NOT IN ('blocked','left') ORDER BY g.name,g.id LIMIT 1`).bind(linked.user_id, target.id).first();
  if (group) headers.append('Set-Cookie', cookieHeader(request, 'photown_group', await signToken(env, { publisher: target.id, group: group.id }, 'participant', 43200), 43200));
  return Response.json({ purpose: 'login', authenticated: Boolean(group), group }, { headers });
}

export async function linkedEmail(db, userId) {
  return (await db.prepare("SELECT verified_email FROM identity_providers WHERE provider='email' AND user_id=?").bind(userId).first())?.verified_email || null;
}

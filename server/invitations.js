import { digest, HttpError } from './security.js';
import { cookieHeader, randomToken, signToken } from './tokens.js';
import { sendMail, layout } from './mail.js';
import { readEmail, DEVICE_SECONDS } from './email-login.js';
import { createInitialWall, ensureGroupMembership, ensureLocalUser } from './core-v6.js';

// Group invitations by email. Opening the link proves the address, so accepting it
// joins the group and links the email to the person's USER (or opens that USER).
const seconds = () => Math.floor(Date.now() / 1000);
const now = () => new Date().toISOString();
export const INVITATION_SECONDS = 7 * 24 * 60 * 60;
const MAX_PER_REQUEST = 20;
const localHosts = ['localhost', '127.0.0.1'];
const devLinks = (env, request) => env.DEV_LOGIN_LINKS === 'true' && localHosts.includes(new URL(request.url).hostname);

export async function sendInvitations(request, env, db, { groupId, groupName, actorUserId, emails }) {
  const list = (typeof emails === 'string' ? emails.split(/[\s,;]+/) : Array.isArray(emails) ? emails : []).map(value => String(value).trim()).filter(Boolean);
  if (!list.length) throw new HttpError(400, 'Escribe al menos un correo.');
  if (list.length > MAX_PER_REQUEST) throw new HttpError(400, `Invita como máximo a ${MAX_PER_REQUEST} correos cada vez.`);
  await db.prepare('DELETE FROM group_invitations WHERE expires_at<? AND accepted_at IS NULL').bind(seconds()).run();
  const results = [], seen = new Set();
  for (const raw of list) {
    let address;
    try { address = readEmail(raw); } catch { results.push({ email: raw, status: 'invalid' }); continue; }
    if (seen.has(address.email)) continue;
    seen.add(address.email);
    const member = await db.prepare(`SELECT 1 FROM identity_providers ip JOIN group_memberships gm ON gm.user_id=ip.user_id
      WHERE ip.provider='email' AND ip.email=? AND gm.group_id=? AND gm.state NOT IN ('left')`).bind(address.email, groupId).first();
    if (member) { results.push({ email: address.display, status: 'member' }); continue; }
    const recent = await db.prepare('SELECT 1 FROM group_invitations WHERE group_id=? AND email=? AND accepted_at IS NULL AND created_at>?').bind(groupId, address.email, seconds() - 600).first();
    if (recent) { results.push({ email: address.display, status: 'recent' }); continue; }
    const token = randomToken();
    const link = `${new URL(request.url).origin}/invite?token=${token}`;
    const message = layout({
      title: `Te invitan a ${groupName} en PhoTown`,
      paragraphs: ['PhoTown es un diario fotográfico compartido en blanco y negro.', 'Pulsa el botón para unirte al grupo. Tu correo quedará vinculado y podrás entrar desde cualquier dispositivo con «Entrar con mi correo».', 'La invitación caduca en 7 días y solo sirve una vez.'],
      action: 'Unirme al grupo', link,
      footer: 'Si no esperabas esta invitación, puedes ignorar este correo.'
    });
    let delivered = false;
    try { delivered = await sendMail(env, { to: address.display, subject: `Invitación a ${groupName} en PhoTown`, ...message }); }
    catch (error) { console.error('Invitation delivery failed', error); }
    if (!delivered && !devLinks(env, request)) { results.push({ email: address.display, status: 'failed' }); continue; }
    await db.prepare('INSERT INTO group_invitations (token_hash,group_id,email,display_email,invited_by_user_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
      .bind(await digest(token), groupId, address.email, address.display, actorUserId ?? null, seconds(), seconds() + INVITATION_SECONDS).run();
    results.push({ email: address.display, status: 'sent', ...(devLinks(env, request) ? { dev_link: link } : {}) });
  }
  return { results };
}

export async function listInvitations(db, groupId) {
  const rows = (await db.prepare(`SELECT display_email AS email,created_at,expires_at,accepted_at FROM group_invitations
    WHERE group_id=? ORDER BY created_at DESC LIMIT 100`).bind(groupId).all()).results;
  const time = seconds();
  return rows.map(row => ({ email: row.email, sent_at: new Date(row.created_at * 1000).toISOString(), status: row.accepted_at ? 'accepted' : row.expires_at < time ? 'expired' : 'pending' }));
}

async function openInvitation(db, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare(`SELECT i.token_hash,i.group_id,i.email,i.display_email,g.name FROM group_invitations i JOIN groups g ON g.id=i.group_id
    WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.expires_at>? AND g.active=1`).bind(await digest(token), seconds()).first();
}
const invalid = () => new HttpError(410, 'Esta invitación no es válida, ya se usó o ha caducado. Pide una nueva a quien administra el grupo.');

export async function previewInvitation(db, body) {
  const invitation = await openInvitation(db, body?.token);
  if (!invitation) throw invalid();
  return { group: invitation.name, email: invitation.display_email };
}

export async function acceptInvitation(request, env, db, body, current) {
  const invitation = await openInvitation(db, body?.token);
  if (!invitation) throw invalid();
  // Consume first so two simultaneous clicks cannot both succeed.
  const claimed = await db.prepare('UPDATE group_invitations SET accepted_at=? WHERE token_hash=? AND accepted_at IS NULL').bind(seconds(), invitation.token_hash).run();
  if (!claimed.meta.changes) throw invalid();
  const headers = new Headers();
  const linked = await db.prepare("SELECT user_id FROM identity_providers WHERE provider='email' AND email=?").bind(invitation.email).first();
  let publisher;
  if (linked) {
    // The address already belongs to a USER: open that USER on this device, as «Entrar con mi correo» does.
    publisher = await db.prepare('SELECT id,user_id FROM publishers WHERE user_id=? ORDER BY last_seen DESC LIMIT 1').bind(linked.user_id).first();
    if (publisher && publisher.user_id !== current?.user_id) {
      const session = randomToken();
      await db.prepare('INSERT INTO device_sessions (token_hash,publisher_id,created_at,expires_at) VALUES (?,?,?,?)').bind(await digest(session), publisher.id, seconds(), seconds() + DEVICE_SECONDS).run();
      headers.append('Set-Cookie', cookieHeader(request, 'photown_publisher', session, DEVICE_SECONDS));
    } else if (publisher) publisher = current;
  }
  if (!publisher) {
    publisher = current;
    if (!publisher) {
      const token = randomToken(); publisher = { id: crypto.randomUUID() }; publisher.user_id = publisher.id;
      await db.batch([
        db.prepare("INSERT INTO users (id,status,created_at) VALUES (?,'active',?)").bind(publisher.user_id, now()),
        db.prepare('INSERT INTO publishers (id,token_hash,created_at,last_seen,user_id) VALUES (?,?,?,?,?)').bind(publisher.id, await digest(token), now(), now(), publisher.user_id)
      ]);
      headers.append('Set-Cookie', cookieHeader(request, 'photown_publisher', token, 31536000));
    }
    publisher.user_id ||= await ensureLocalUser(db, publisher.id);
    if (!linked) {
      const other = await db.prepare("SELECT 1 FROM identity_providers WHERE provider='email' AND user_id=?").bind(publisher.user_id).first();
      // A person with another address already linked keeps it; the invitation still lets them in.
      if (!other) await db.prepare("INSERT OR IGNORE INTO identity_providers (id,user_id,provider,subject,email,verified_email,created_at) VALUES (?,?,'email',?,?,?,?)")
        .bind(crypto.randomUUID(), publisher.user_id, invitation.email, invitation.email, invitation.display_email, now()).run();
    }
  }
  if (!(await db.prepare("SELECT id FROM walls WHERE group_id=? AND state='open'").bind(invitation.group_id).first())) {
    const group = await db.prepare('SELECT name,created_at FROM groups WHERE id=?').bind(invitation.group_id).first();
    await createInitialWall(db, invitation.group_id, group.name, group.created_at);
  }
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO memberships (publisher_id,group_id) VALUES (?,?)').bind(publisher.id, invitation.group_id),
    db.prepare('UPDATE publishers SET last_seen=? WHERE id=?').bind(now(), publisher.id),
    db.prepare('UPDATE group_invitations SET accepted_user_id=? WHERE token_hash=?').bind(publisher.user_id, invitation.token_hash)
  ]);
  const legacy = await db.prepare('SELECT status FROM memberships WHERE publisher_id=? AND group_id=?').bind(publisher.id, invitation.group_id).first();
  const membership = await ensureGroupMembership(db, publisher.user_id, invitation.group_id, legacy?.status);
  if (membership.state === 'blocked') throw new HttpError(403, 'Tu participación en este grupo está bloqueada.');
  if (membership.state === 'left') await db.prepare("UPDATE group_memberships SET state='active' WHERE user_id=? AND group_id=?").bind(publisher.user_id, invitation.group_id).run();
  headers.append('Set-Cookie', cookieHeader(request, 'photown_group', await signToken(env, { publisher: publisher.id, group: invitation.group_id }, 'participant', 43200), 43200));
  return Response.json({ authenticated: true, group: { id: invitation.group_id, name: invitation.name } }, { headers });
}

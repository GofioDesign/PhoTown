import { adminEmails } from './google-auth.js';
import { sendMail, layout } from './mail.js';

const now = () => new Date().toISOString();
const newId = "lower(hex(randomblob(16)))";

// In-app notices. Fan-out is a single INSERT … SELECT so it stays cheap for
// classroom-sized groups and never notifies blocked members or the author.
export function photoPublished(db, photoId) {
  return db.prepare(`INSERT INTO notifications (id,publisher_id,group_id,kind,photo_id,challenge_id,actor,created_at)
    SELECT ${newId},m.publisher_id,p.group_id,'photo',p.id,p.challenge_id,COALESCE((SELECT alias FROM memberships a WHERE a.publisher_id=p.publisher_id AND a.group_id=p.group_id),''),?
    FROM photos p JOIN memberships m ON m.group_id=p.group_id
    WHERE p.id=? AND p.status='published' AND m.publisher_id!=p.publisher_id AND m.status!='BLOCKED'`).bind(now(), photoId);
}
export function photoApproved(db, photoId) {
  return db.prepare(`INSERT INTO notifications (id,publisher_id,group_id,kind,photo_id,created_at)
    SELECT ${newId},publisher_id,group_id,'approved',id,? FROM photos WHERE id=? AND status='published' AND publisher_id IS NOT NULL`).bind(now(), photoId);
}
export function reactionAdded(db, photoId, actorId, kind) {
  return db.prepare(`INSERT INTO notifications (id,publisher_id,group_id,kind,photo_id,actor,detail,created_at)
    SELECT ${newId},p.publisher_id,p.group_id,'reaction',p.id,COALESCE((SELECT alias FROM memberships a WHERE a.publisher_id=? AND a.group_id=p.group_id),''),?,?
    FROM photos p WHERE p.id=? AND p.publisher_id IS NOT NULL AND p.publisher_id!=?`).bind(actorId, kind, now(), photoId, actorId);
}
export function challengeCreated(db, challengeId) {
  return db.prepare(`INSERT INTO notifications (id,publisher_id,group_id,kind,challenge_id,detail,created_at)
    SELECT ${newId},m.publisher_id,c.group_id,'challenge',c.id,c.title,? FROM challenges c JOIN memberships m ON m.group_id=c.group_id
    WHERE c.id=? AND m.status!='BLOCKED'`).bind(now(), challengeId);
}

const reactionNames = { like: 'Me gusta', light: 'Buena luz', composition: 'Buena composición', idea: 'Buena idea' };
export function describe(n) {
  const who = n.actor || 'Alguien';
  if (n.kind === 'photo') return `${who} ha publicado una foto${n.challenge_title ? ` para el reto «${n.challenge_title}»` : ''} en ${n.group_name || 'tu grupo'}.`;
  if (n.kind === 'approved') return `Tu foto ya está en el muro de ${n.group_name || 'tu grupo'}.`;
  if (n.kind === 'reaction') return `${who} ha reaccionado a tu foto: ${reactionNames[n.detail] || 'Me gusta'}.`;
  if (n.kind === 'challenge') return `Nuevo reto en ${n.group_name || 'tu grupo'}: «${n.detail}».`;
  return 'Hay novedades en PhoTown.';
}

// Hourly digests from the scheduled handler. Each participant receives at most
// one email per run summarising unread notices; administrators receive one
// summary of photographs newly waiting for approval.
export async function sendDigests(env, db) {
  const base = (env.PUBLIC_URL || 'https://photown.gofiodesign.eu').replace(/\/$/, '');
  const recipients = (await db.prepare(`SELECT DISTINCT p.id,p.email FROM notifications n JOIN publishers p ON p.id=n.publisher_id
    WHERE n.emailed_at IS NULL AND n.read_at IS NULL AND p.email IS NOT NULL AND p.email_digest=1 LIMIT 50`).all()).results;
  for (const person of recipients) {
    const items = (await db.prepare(`SELECT n.*,g.name AS group_name,c.title AS challenge_title FROM notifications n LEFT JOIN groups g ON g.id=n.group_id LEFT JOIN challenges c ON c.id=n.challenge_id
      WHERE n.publisher_id=? AND n.emailed_at IS NULL AND n.read_at IS NULL ORDER BY n.created_at DESC LIMIT 20`).bind(person.id).all()).results;
    if (!items.length) continue;
    const message = layout({
      title: items.length === 1 ? 'Una novedad en PhoTown' : `${items.length} novedades en PhoTown`,
      paragraphs: items.slice(0, 8).map(describe).concat(items.length > 8 ? [`Y ${items.length - 8} más.`] : []),
      action: 'Ver en PhoTown', link: `${base}/notifications`,
      footer: 'Puedes desactivar estos resúmenes en PhoTown → Personalización.'
    });
    try { await sendMail(env, { to: person.email, subject: message.text.split('\n')[0], ...message }); }
    catch (error) { console.error('Digest email failed', error); continue; }
    await db.prepare('UPDATE notifications SET emailed_at=? WHERE publisher_id=? AND emailed_at IS NULL').bind(now(), person.id).run();
  }
  // Read notices never need an email.
  await db.prepare('UPDATE notifications SET emailed_at=? WHERE emailed_at IS NULL AND read_at IS NOT NULL').bind(now()).run();

  const cutoff = now();
  const pending = (await db.prepare(`SELECT g.id,g.name,COUNT(*) AS n FROM photos p JOIN groups g ON g.id=p.group_id
    WHERE p.status='pending' AND p.admin_notified_at IS NULL AND p.created_at<=? GROUP BY g.id,g.name ORDER BY g.name`).bind(cutoff).all()).results;
  if (pending.length) {
    const total = pending.reduce((sum, group) => sum + group.n, 0);
    const message = layout({
      title: total === 1 ? 'Una foto espera aprobación' : `${total} fotos esperan aprobación`,
      paragraphs: pending.map(group => `${group.name}: ${group.n} ${group.n === 1 ? 'foto nueva' : 'fotos nuevas'}.`),
      action: 'Revisar en administración', link: `${base}/admin`
    });
    let delivered = true;
    for (const email of adminEmails(env)) {
      try { await sendMail(env, { to: email, subject: message.text.split('\n')[0] + ' · PhoTown', ...message }); }
      catch (error) { delivered = false; console.error('Admin email failed', error); }
    }
    if (delivered) await db.prepare("UPDATE photos SET admin_notified_at=? WHERE status='pending' AND admin_notified_at IS NULL AND created_at<=?").bind(now(), cutoff).run();
  }
}

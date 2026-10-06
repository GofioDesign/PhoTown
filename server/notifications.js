import { HttpError } from './security.js';
import { signToken, verifyToken } from './tokens.js';
import { sendMail, mailReady, layout } from './mail.js';
import { photoWeek } from './community.js';
import { pushReady, sendPush } from './push.js';

// Notifications sent from the cron (every 10 minutes), by email and by Web Push to every
// device that accepted them: a digest of new photos for wall members (daily or weekly, per
// USER) and, for a group's owner, admins and moderators, a notice as soon as a new photo
// waits for review (daytime only). Each message is recorded before sending, so overlapping
// or retried runs never send twice; a message no channel delivered releases its record
// for the next run.
const TIME_ZONE = 'Atlantic/Canary';
const SEND_HOUR = 9;
const QUIET_HOUR = 23; // no moderation notices from 23:00 until SEND_HOUR
const MAX_PER_RUN = 20;
const KEEP_DELIVERIES_DAYS = 60;
const UNSUBSCRIBE_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_ORIGIN = 'https://photown.gofiodesign.eu';
export const DIGESTS = ['off', 'daily', 'weekly'];

const seconds = date => Math.floor(date.getTime() / 1000);
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const origin = env => (env.APP_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, '');
const userEmail = `(SELECT COALESCE(ip.verified_email,ip.email) FROM identity_providers ip WHERE ip.user_id=u.id AND ip.email IS NOT NULL
  ORDER BY CASE ip.provider WHEN 'email' THEN 0 ELSE 1 END,ip.created_at LIMIT 1)`;

export function localClock(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(date).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), monday: parts.weekday === 'Mon' };
}

export async function readPreferences(db, userId) {
  const [row, email, moderates, devices] = await Promise.all([
    db.prepare('SELECT digest,moderation FROM notification_preferences WHERE user_id=?').bind(userId).first(),
    db.prepare(`SELECT ${userEmail} AS email FROM users u WHERE u.id=?`).bind(userId).first(),
    db.prepare("SELECT 1 FROM group_memberships WHERE user_id=? AND state='active' AND role IN ('owner','admin','moderator') LIMIT 1").bind(userId).first(),
    db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?').bind(userId).first()
  ]);
  return { email: email?.email ?? null, digest: row?.digest ?? 'weekly', moderation: row ? Boolean(row.moderation) : true, moderates: Boolean(moderates), devices: devices?.n ?? 0 };
}

export async function savePreferences(db, userId, body) {
  const current = await readPreferences(db, userId);
  if ('digest' in (body || {}) && !DIGESTS.includes(body.digest)) throw new HttpError(400, 'Frecuencia de resumen no válida.');
  if ('moderation' in (body || {}) && typeof body.moderation !== 'boolean') throw new HttpError(400, 'Preferencia de avisos no válida.');
  const digest = body?.digest ?? current.digest, moderation = body?.moderation ?? current.moderation;
  await db.prepare(`INSERT INTO notification_preferences (user_id,digest,moderation,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET digest=excluded.digest,moderation=excluded.moderation,updated_at=excluded.updated_at`)
    .bind(userId, digest, Number(moderation), new Date().toISOString()).run();
  return readPreferences(db, userId);
}

// The token proves which person and which kind of notice; nothing else is needed to stop it.
export async function unsubscribe(env, db, token) {
  const claims = typeof token === 'string' && token.length < 1024 ? await verifyToken(env, token, 'unsubscribe') : null;
  if (!claims || typeof claims.user !== 'string' || !['digest', 'moderation'].includes(claims.kind)) throw new HttpError(400, 'Este enlace para darse de baja no es válido.');
  if (!(await db.prepare('SELECT 1 FROM users WHERE id=?').bind(claims.user).first())) throw new HttpError(400, 'Este enlace para darse de baja no es válido.');
  await savePreferences(db, claims.user, claims.kind === 'digest' ? { digest: 'off' } : { moderation: false });
  return { unsubscribed: claims.kind };
}

async function unsubscribeLinks(env, userId, kind) {
  const token = await signToken(env, { user: userId, kind }, 'unsubscribe', UNSUBSCRIBE_SECONDS);
  return {
    page: `${origin(env)}/unsubscribe?token=${token}`,
    headers: { 'List-Unsubscribe': `<${origin(env)}/api/unsubscribe?token=${token}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  };
}

const activeGroup = "gm.state='active' AND g.active=1 AND g.operational_state='active'";

async function digestMessage(env, db, user, kind, since) {
  const groups = (await db.prepare(`SELECT g.name,COUNT(p.id) AS photos FROM group_memberships gm JOIN groups g ON g.id=gm.group_id
    JOIN photos p ON p.group_id=g.id AND p.status='published' AND p.published_at>=? AND COALESCE(p.user_id,'')!=gm.user_id
    WHERE gm.user_id=? AND ${activeGroup} GROUP BY g.id ORDER BY photos DESC,g.name`).bind(since, user.user_id).all()).results;
  const total = groups.reduce((sum, group) => sum + group.photos, 0);
  if (!total) return null;
  const links = await unsubscribeLinks(env, user.user_id, 'digest');
  const period = kind === 'daily' ? 'las últimas 24 horas' : 'la última semana';
  return {
    push: { title: `${plural(total, 'foto nueva', 'fotos nuevas')} en PhoTown`, body: groups.map(group => `${group.name}: ${group.photos}`).join(' · '), url: '/wall', tag: 'digest' },
    subject: `PhoTown: ${plural(total, 'foto nueva', 'fotos nuevas')}`,
    headers: links.headers,
    ...layout({
      title: `${plural(total, 'foto nueva', 'fotos nuevas')} en tus muros`,
      paragraphs: [`Esto es lo que se ha publicado en ${period}:`, ...groups.map(group => `«${group.name}»: ${plural(group.photos, 'foto nueva', 'fotos nuevas')}.`)],
      action: 'Ver el muro', link: `${origin(env)}/wall`,
      footer: `Recibes este resumen ${kind === 'daily' ? 'diario' : 'semanal'} porque participas en estos grupos. Puedes cambiar la frecuencia en Personalización.`,
      unsubscribe: links.page
    })
  };
}

async function moderationMessage(env, db, user) {
  const groups = (await db.prepare(`SELECT g.name,COUNT(p.id) AS photos FROM group_memberships gm JOIN groups g ON g.id=gm.group_id
    JOIN photos p ON p.group_id=g.id AND p.status='pending'
    WHERE gm.user_id=? AND gm.role IN ('owner','admin','moderator') AND gm.state='active' AND g.active=1 GROUP BY g.id ORDER BY photos DESC,g.name`).bind(user.user_id).all()).results;
  const total = groups.reduce((sum, group) => sum + group.photos, 0);
  if (!total) return null;
  const links = await unsubscribeLinks(env, user.user_id, 'moderation');
  return {
    push: { title: `${plural(total, 'foto pendiente', 'fotos pendientes')} de revisar`, body: groups.map(group => `${group.name}: ${group.photos}`).join(' · '), url: '/admin', tag: 'moderation' },
    subject: `PhoTown: ${plural(total, 'foto pendiente', 'fotos pendientes')} de revisar`,
    headers: links.headers,
    ...layout({
      title: `${plural(total, 'foto espera', 'fotos esperan')} tu revisión`,
      paragraphs: groups.map(group => `«${group.name}»: ${plural(group.photos, 'foto pendiente', 'fotos pendientes')}.`),
      action: 'Revisar en Administración', link: `${origin(env)}/admin`,
      footer: 'Recibes este aviso porque moderas estos grupos. Llega cuando hay fotos nuevas por revisar, entre las 9:00 y las 23:00.',
      unsubscribe: links.page
    })
  };
}

async function candidates(db, kind, period, since, limit) {
  const reachable = '(EXISTS(SELECT 1 FROM identity_providers ip WHERE ip.user_id=u.id AND ip.email IS NOT NULL) OR EXISTS(SELECT 1 FROM push_subscriptions ps WHERE ps.user_id=u.id))';
  const pending = 'NOT EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.user_id=u.id AND d.kind=? AND d.period=?)';
  // Moderators hear about a pending photo once: only photos uploaded after their last notice count.
  if (kind === 'moderation') return (await db.prepare(`SELECT u.id AS user_id,${userEmail} AS email FROM users u
    LEFT JOIN notification_preferences np ON np.user_id=u.id
    WHERE u.status='active' AND COALESCE(np.moderation,1)=1 AND ${pending}
      AND EXISTS(SELECT 1 FROM group_memberships gm JOIN groups g ON g.id=gm.group_id WHERE gm.user_id=u.id AND gm.role IN ('owner','admin','moderator') AND gm.state='active' AND g.active=1
        AND EXISTS(SELECT 1 FROM photos p WHERE p.group_id=g.id AND p.status='pending'
          AND CAST(strftime('%s',p.created_at) AS INTEGER)>COALESCE((SELECT MAX(d.sent_at) FROM notification_deliveries d WHERE d.user_id=u.id AND d.kind='moderation'),0)))
      AND ${reachable}
    LIMIT ?`).bind(kind, period, limit).all()).results;
  return (await db.prepare(`SELECT u.id AS user_id,${userEmail} AS email FROM users u
    LEFT JOIN notification_preferences np ON np.user_id=u.id
    WHERE u.status='active' AND COALESCE(np.digest,'weekly')=? AND ${pending}
      AND EXISTS(SELECT 1 FROM group_memberships gm JOIN groups g ON g.id=gm.group_id JOIN photos p ON p.group_id=g.id
        WHERE gm.user_id=u.id AND ${activeGroup} AND p.status='published' AND p.published_at>=? AND COALESCE(p.user_id,'')!=u.id)
      AND ${reachable}
    LIMIT ?`).bind(kind, kind, period, since, limit).all()).results;
}

export async function sendNotifications(env, date = new Date()) {
  const mail = mailReady(env) || Array.isArray(env.MAIL_OUTBOX);
  if (!env.DB || !(mail || pushReady(env))) return { sent: 0 };
  const db = env.DB.withSession('first-primary');
  const clock = localClock(date);
  await db.prepare('DELETE FROM notification_deliveries WHERE sent_at<?').bind(seconds(date) - KEEP_DELIVERIES_DAYS * 86400).run();
  if (clock.hour < SEND_HOUR) return { sent: 0 };
  const runs = [{ kind: 'daily', period: clock.day, since: new Date(date - 86400000).toISOString() }];
  if (clock.hour < QUIET_HOUR) runs.unshift({ kind: 'moderation', period: date.toISOString().slice(0, 16) });
  if (clock.monday) runs.push({ kind: 'weekly', period: photoWeek(date), since: new Date(date - 7 * 86400000).toISOString() });
  let sent = 0, failed = 0;
  for (const run of runs) {
    if (sent >= MAX_PER_RUN) break;
    for (const user of await candidates(db, run.kind, run.period, run.since, MAX_PER_RUN - sent)) {
      const claimed = await db.prepare('INSERT OR IGNORE INTO notification_deliveries (user_id,kind,period,sent_at) VALUES (?,?,?,?)').bind(user.user_id, run.kind, run.period, seconds(date)).run();
      if (!claimed.meta.changes) continue;
      const message = run.kind === 'moderation' ? await moderationMessage(env, db, user) : await digestMessage(env, db, user, run.kind, run.since);
      if (!message) continue;
      const { push, ...email } = message;
      let delivered = (await sendPush(env, db, user.user_id, push)) > 0;
      if (mail && user.email) {
        try { delivered = (await sendMail(env, { to: user.email, ...email })) || delivered; }
        catch (error) { console.error('Notification delivery failed', error); }
      }
      if (!delivered) {
        await db.prepare('DELETE FROM notification_deliveries WHERE user_id=? AND kind=? AND period=?').bind(user.user_id, run.kind, run.period).run();
        failed++;
        continue;
      }
      sent++;
    }
  }
  return failed ? { sent, failed } : { sent };
}

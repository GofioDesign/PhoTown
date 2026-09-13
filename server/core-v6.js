import { HttpError } from './security.js';

const now = () => new Date().toISOString();

export async function ensureLocalUser(db, publisherId) {
  const publisher = await db.prepare('SELECT id,user_id FROM publishers WHERE id=?').bind(publisherId).first();
  if (!publisher) throw new HttpError(401, 'La identidad local ya no está disponible.');
  if (publisher.user_id) return publisher.user_id;
  const userId = publisher.id;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO users (id,status,created_at) VALUES (?,'active',?)").bind(userId, now()),
    db.prepare('UPDATE publishers SET user_id=? WHERE id=? AND user_id IS NULL').bind(userId, publisher.id)
  ]);
  return userId;
}

export async function ensureGroupMembership(db, userId, groupId, legacyStatus = 'NEW') {
  let membership = await db.prepare('SELECT * FROM group_memberships WHERE user_id=? AND group_id=?').bind(userId, groupId).first();
  if (membership) return membership;
  const parId = crypto.randomUUID();
  await db.prepare(`INSERT INTO group_memberships
    (user_id,group_id,par_id,role,state,trust,joined_at)
    VALUES (?,?,?,'user',?,?,?)`).bind(
      userId,
      groupId,
      parId,
      legacyStatus === 'BLOCKED' ? 'blocked' : 'active',
      legacyStatus === 'TRUSTED' ? 1 : 0,
      now()
    ).run();
  return db.prepare('SELECT * FROM group_memberships WHERE user_id=? AND group_id=?').bind(userId, groupId).first();
}

export async function ensureAdminPrincipal(db, identity, superadminEmails = []) {
  if (!identity?.sub || !identity?.email) return null;
  const email = identity.email.toLowerCase();
  let provider = await db.prepare("SELECT user_id FROM identity_providers WHERE provider='google' AND subject=?").bind(identity.sub).first();
  let userId = provider?.user_id;
  if (!userId) {
    const byEmail = await db.prepare("SELECT user_id FROM identity_providers WHERE provider='google' AND email=?").bind(email).first();
    userId = byEmail?.user_id || crypto.randomUUID();
    const timestamp = now();
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO users (id,status,created_at) VALUES (?,'active',?)").bind(userId, timestamp),
      db.prepare("INSERT OR IGNORE INTO identity_providers (id,user_id,provider,subject,email,created_at) VALUES (?,?,'google',?,?,?)").bind(crypto.randomUUID(), userId, identity.sub, email, timestamp)
    ]);
    provider = await db.prepare("SELECT user_id FROM identity_providers WHERE provider='google' AND subject=?").bind(identity.sub).first();
    userId = provider?.user_id || userId;
  }
  const isSuperadmin = superadminEmails.includes(email);
  if (isSuperadmin) {
    await db.prepare("INSERT OR IGNORE INTO global_roles (user_id,role,created_at) VALUES (?,'superadmin',?)").bind(userId, now()).run();
    const groups = (await db.prepare('SELECT id FROM groups').all()).results;
    for (const group of groups) {
      await db.prepare(`INSERT INTO group_memberships (user_id,group_id,par_id,role,state,trust,joined_at)
        VALUES (?,?,?,'admin','active',0,?)
        ON CONFLICT(user_id,group_id) DO UPDATE SET role='admin',state='active'`)
        .bind(userId, group.id, crypto.randomUUID(), now()).run();
    }
  }
  return { ...identity, user_id: userId, superadmin: isSuperadmin };
}

export async function groupAuthority(db, principal, groupId, roles = ['admin']) {
  if (!principal?.user_id) return null;
  const membership = await db.prepare('SELECT role,state FROM group_memberships WHERE user_id=? AND group_id=?').bind(principal.user_id, groupId).first();
  if (!membership || membership.state !== 'active' || !roles.includes(membership.role)) return null;
  return membership;
}

export async function requireGroupAuthority(db, principal, groupId, roles = ['admin']) {
  const membership = await groupAuthority(db, principal, groupId, roles);
  if (!membership) throw new HttpError(403, 'No tienes permisos para administrar este grupo.');
  return membership;
}

export async function createInitialWall(db, groupId, groupName, openedAt = now()) {
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO walls (id,group_id,name,state,opened_at,arrangement_version) VALUES (?,?,?,'open',?,1)")
    .bind(id, groupId, groupName, openedAt).run();
  return id;
}

export async function addPhotoToCurrentWall(db, groupId, photoId, addedAt = now()) {
  const wall = await db.prepare("SELECT id FROM walls WHERE group_id=? AND state='open'").bind(groupId).first();
  if (!wall) throw new HttpError(409, 'El grupo no tiene un WALL abierto.');
  await db.prepare(`INSERT OR IGNORE INTO wall_photos (wall_id,photo_id,position,added_at)
    SELECT ?,?,COALESCE(MAX(position)+1,0),? FROM wall_photos WHERE wall_id=?`)
    .bind(wall.id, photoId, addedAt, wall.id).run();
  return wall.id;
}

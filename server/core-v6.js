import { HttpError } from './security.js';
import { canonicalEmail } from './identity.js';

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
  const email = canonicalEmail(identity.email);
  const verifiedEmail = String(identity.display_email || identity.email).trim();
  const assignments = (await db.prepare('SELECT group_id,role FROM group_role_assignments WHERE email=?').bind(email).all()).results;
  const isSuperadmin = superadminEmails.map(canonicalEmail).includes(email);
  if (!isSuperadmin && !assignments.length) return null;
  let provider = await db.prepare("SELECT user_id FROM identity_providers WHERE provider='google' AND subject=?").bind(identity.sub).first();
  let userId = provider?.user_id;
  if (!userId) {
    const byEmail = await db.prepare("SELECT user_id FROM identity_providers WHERE provider='google' AND email=?").bind(email).first();
    userId = byEmail?.user_id || crypto.randomUUID();
    const timestamp = now();
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO users (id,status,created_at) VALUES (?,'active',?)").bind(userId, timestamp),
      db.prepare("INSERT OR IGNORE INTO identity_providers (id,user_id,provider,subject,email,verified_email,created_at) VALUES (?,?,'google',?,?,?,?)").bind(crypto.randomUUID(), userId, identity.sub, email, verifiedEmail, timestamp)
    ]);
    provider = await db.prepare("SELECT user_id FROM identity_providers WHERE provider='google' AND subject=?").bind(identity.sub).first();
    userId = provider?.user_id || userId;
  }
  if (isSuperadmin) {
    await db.prepare("INSERT OR IGNORE INTO global_roles (user_id,role,created_at) VALUES (?,'superadmin',?)").bind(userId, now()).run();
  }
  for (const assignment of assignments) {
    await db.batch([
      db.prepare(`INSERT INTO group_memberships (user_id,group_id,par_id,role,state,trust,joined_at)
        VALUES (?,?,?,?,'active',0,?)
        ON CONFLICT(user_id,group_id) DO UPDATE SET role=excluded.role,state='active'`)
        .bind(userId, assignment.group_id, crypto.randomUUID(), assignment.role, now()),
      db.prepare('UPDATE group_role_assignments SET claimed_user_id=? WHERE group_id=? AND email=?').bind(userId, assignment.group_id, email)
    ]);
  }
  return { ...identity, email, user_id: userId, superadmin: isSuperadmin };
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

const roleEventStatement = (db, groupId, actorUserId, subjectEmail, oldRole, newRole, reason) =>
  db.prepare('INSERT INTO role_events (id,group_id,actor_user_id,subject_email,old_role,new_role,reason,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), groupId, actorUserId ?? null, subjectEmail, oldRole ?? null, newRole ?? null, reason, now());

export async function groupOwner(db, groupId) {
  return db.prepare("SELECT email,display_email,claimed_user_id FROM group_role_assignments WHERE group_id=? AND role='owner'").bind(groupId).first();
}

// Owner-only: add or change an admin or moderator. The owner itself changes only through a transfer.
export async function assignGroupRole(db, actorUserId, groupId, rawEmail, role) {
  if (!['admin', 'moderator'].includes(role)) throw new HttpError(400, 'Rol no válido.');
  const email = canonicalEmail(rawEmail);
  const existing = await db.prepare('SELECT role,claimed_user_id FROM group_role_assignments WHERE group_id=? AND email=?').bind(groupId, email).first();
  if (existing?.role === 'owner') throw new HttpError(409, 'Para cambiar el rol del owner, transfiere antes la propiedad del grupo.');
  if (existing?.role === role) return { email, role };
  const statements = [
    db.prepare(`INSERT INTO group_role_assignments (group_id,email,display_email,role,assigned_by_user_id,created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(group_id,email) DO UPDATE SET role=excluded.role,display_email=excluded.display_email,assigned_by_user_id=excluded.assigned_by_user_id`)
      .bind(groupId, email, String(rawEmail).trim(), role, actorUserId, now()),
    roleEventStatement(db, groupId, actorUserId, email, existing?.role, role, existing ? 'role_changed' : 'role_assigned')
  ];
  if (existing?.claimed_user_id) statements.push(db.prepare("UPDATE group_memberships SET role=? WHERE user_id=? AND group_id=? AND role!='owner'").bind(role, existing.claimed_user_id, groupId));
  await db.batch(statements);
  return { email, role };
}

export async function removeGroupRole(db, actorUserId, groupId, rawEmail) {
  const email = canonicalEmail(rawEmail);
  const existing = await db.prepare('SELECT role,claimed_user_id FROM group_role_assignments WHERE group_id=? AND email=?').bind(groupId, email).first();
  if (!existing) throw new HttpError(404, 'Esa cuenta no tiene un rol en este grupo.');
  if (existing.role === 'owner') throw new HttpError(409, 'El owner no puede retirarse sin transferir antes la propiedad del grupo.');
  const statements = [
    db.prepare("DELETE FROM group_role_assignments WHERE group_id=? AND email=? AND role!='owner'").bind(groupId, email),
    roleEventStatement(db, groupId, actorUserId, email, existing.role, null, 'role_removed')
  ];
  if (existing.claimed_user_id) statements.push(db.prepare("UPDATE group_memberships SET role='user' WHERE user_id=? AND group_id=? AND role!='owner'").bind(existing.claimed_user_id, groupId));
  await db.batch(statements);
  return { email, removed: true };
}

// Bootstrap (no owner yet) or transfer (current owner hands over). The previous owner stays as admin.
// Every statement runs in one batch so the group never has zero or two owners.
export async function setGroupOwner(db, actorUserId, groupId, rawEmail, { claimedUserId = null } = {}) {
  const email = canonicalEmail(rawEmail);
  const current = await groupOwner(db, groupId);
  if (current?.email === email) return { email, role: 'owner' };
  const target = await db.prepare('SELECT role,claimed_user_id FROM group_role_assignments WHERE group_id=? AND email=?').bind(groupId, email).first();
  const claimed = target?.claimed_user_id || claimedUserId;
  const statements = [];
  if (current) {
    statements.push(
      db.prepare("UPDATE group_role_assignments SET role='admin',assigned_by_user_id=? WHERE group_id=? AND role='owner'").bind(actorUserId, groupId),
      db.prepare("UPDATE group_memberships SET role='admin' WHERE group_id=? AND role='owner'").bind(groupId),
      roleEventStatement(db, groupId, actorUserId, current.email, 'owner', 'admin', 'ownership_transferred')
    );
  }
  statements.push(
    db.prepare(`INSERT INTO group_role_assignments (group_id,email,display_email,role,assigned_by_user_id,claimed_user_id,created_at)
      VALUES (?,?,?,'owner',?,?,?) ON CONFLICT(group_id,email) DO UPDATE SET role='owner',assigned_by_user_id=excluded.assigned_by_user_id`)
      .bind(groupId, email, String(rawEmail).trim(), actorUserId, claimed, now()),
    roleEventStatement(db, groupId, actorUserId, email, target?.role, 'owner', current ? 'ownership_transferred' : 'owner_bootstrap')
  );
  if (claimed) {
    statements.push(db.prepare(`INSERT INTO group_memberships (user_id,group_id,par_id,role,state,trust,joined_at)
      VALUES (?,?,?,'owner','active',0,?) ON CONFLICT(user_id,group_id) DO UPDATE SET role='owner',state='active'`)
      .bind(claimed, groupId, crypto.randomUUID(), now()));
  }
  await db.batch(statements);
  return { email, role: 'owner' };
}

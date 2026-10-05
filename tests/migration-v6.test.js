import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ensureAdminPrincipal, groupAuthority } from '../server/core-v6.js';

const migration = number => readFileSync(new URL(`../db/migrations/${number}`, import.meta.url), 'utf8');

function legacyDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_groups.sql','0002_participant_alias.sql','0003_waitlist.sql','0004_profile_avatars.sql']) sqlite.exec(migration(file));
  sqlite.exec(`
    INSERT INTO groups (id,name,invite_hash,created_at) VALUES
      ('group-a','A','hash-a','2026-09-01T00:00:00.000Z'),
      ('group-b','B','hash-b','2026-09-02T00:00:00.000Z');
    INSERT INTO publishers (id,token_hash,created_at,last_seen) VALUES
      ('user-a','token-a','2026-09-01T01:00:00.000Z','2026-09-03T00:00:00.000Z'),
      ('user-b','token-b','2026-09-01T02:00:00.000Z','2026-09-03T00:00:00.000Z');
    INSERT INTO memberships (publisher_id,group_id,status,alias) VALUES
      ('user-a','group-a','TRUSTED','Mirada'),
      ('user-a','group-b','MODERATED',''),
      ('user-b','group-a','BLOCKED','');
    INSERT INTO photos (id,publisher_id,group_id,image_key,sha256,description,status,week,created_at) VALUES
      ('photo-1','user-a','group-a','groups/group-a/photos/1.webp','sha-1','Primera','published','2026-W36','2026-09-01T03:00:00.000Z'),
      ('photo-2','user-a','group-a','groups/group-a/photos/2.webp','sha-2','Segunda','published','2026-W36','2026-09-01T04:00:00.000Z'),
      ('photo-copy','user-a','group-b','groups/group-b/photos/3.webp','sha-1','Primera','pending','2026-W36','2026-09-01T05:00:00.000Z');
  `);
  return sqlite;
}

function adapter(sqlite) {
  return { prepare(sql) { let args = []; return {
    bind(...values) { args = values; return this; },
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; }
  }; }, async batch(statements) { sqlite.exec('BEGIN'); try { const out = []; for (const statement of statements) out.push(await statement.run()); sqlite.exec('COMMIT'); return out; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
}

test('v6 migration preserves legacy authorship and creates identified groups with current WALLS', () => {
  const sqlite = legacyDatabase();
  sqlite.exec(migration('0005_core_v6.sql'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
  assert.deepEqual(sqlite.prepare('SELECT identity_mode,timezone FROM groups ORDER BY id').all().map(row => ({ ...row })), [
    { identity_mode: 'identified', timezone: 'Atlantic/Canary' },
    { identity_mode: 'identified', timezone: 'Atlantic/Canary' }
  ]);
  const memberships = sqlite.prepare('SELECT user_id,group_id,role,state,trust FROM group_memberships ORDER BY user_id,group_id').all().map(row => ({ ...row }));
  assert.deepEqual(memberships, [
    { user_id: 'user-a', group_id: 'group-a', role: 'user', state: 'active', trust: 1 },
    { user_id: 'user-a', group_id: 'group-b', role: 'user', state: 'active', trust: 0 },
    { user_id: 'user-b', group_id: 'group-a', role: 'user', state: 'blocked', trust: 0 }
  ]);
  assert.equal(new Set(sqlite.prepare('SELECT par_id FROM group_memberships').all().map(row => row.par_id)).size, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM walls WHERE state='open'").get().n, 2);
  assert.deepEqual(sqlite.prepare("SELECT photo_id,position FROM wall_photos WHERE wall_id='initial-group-a' ORDER BY position").all().map(row => ({ ...row })), [
    { photo_id: 'photo-1', position: 0 },
    { photo_id: 'photo-2', position: 1 }
  ]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM wall_photos WHERE photo_id='photo-copy'").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM photos WHERE sha256='sha-1'").get().n, 2);
  assert.equal(sqlite.prepare("SELECT published_at FROM photos WHERE id='photo-1'").get().published_at, '2026-09-01T03:00:00.000Z');
});

test('global superadmin and per-group authority remain separate dimensions', async () => {
  const sqlite = legacyDatabase(); sqlite.exec(migration('0005_core_v6.sql')); sqlite.exec(migration('0006_identity_ownership.sql'));
  const db = adapter(sqlite);
  const superadmin = await ensureAdminPrincipal(db, { sub: 'google-1', email: 'admin@example.com' }, ['admin@example.com']);
  assert.equal(superadmin.superadmin, true);
  assert.equal(await groupAuthority(db, superadmin, 'group-a', ['admin']), null);
  sqlite.prepare("INSERT INTO group_role_assignments (group_id,email,display_email,role,assigned_by_user_id,created_at) VALUES ('group-a','admin@example.com','admin@example.com','admin',?,'2026-09-03T00:00:00.000Z')").run(superadmin.user_id);
  await ensureAdminPrincipal(db, { sub: 'google-1', email: 'admin@example.com' }, ['admin@example.com']);
  assert.equal((await groupAuthority(db, superadmin, 'group-a', ['admin'])).role, 'admin');
  assert.equal(await groupAuthority(db, superadmin, 'group-b', ['admin']), null);
  assert.equal(sqlite.prepare("SELECT role FROM global_roles WHERE user_id=?").get(superadmin.user_id).role, 'superadmin');
});

test('0006 folds dotted Gmail duplicates, keeps the strongest role and promotes no owner', () => {
  const sqlite = legacyDatabase(); sqlite.exec(migration('0005_core_v6.sql'));
  sqlite.exec(`
    INSERT INTO identity_providers (id,user_id,provider,subject,email,created_at) VALUES
      ('idp-1','user-a','google','sub-1','Ana.Perez@gmail.com','2026-09-03T00:00:00.000Z'),
      ('idp-2','user-b','google','sub-2','ana.perez@example.com','2026-09-03T00:00:00.000Z');
    INSERT INTO group_role_assignments (group_id,email,role,assigned_by_user_id,claimed_user_id,created_at) VALUES
      ('group-a','ana.perez@gmail.com','moderator','user-b','user-a','2026-09-03T00:00:00.000Z'),
      ('group-a','anaperez@gmail.com','admin','user-b',NULL,'2026-09-04T00:00:00.000Z'),
      ('group-a','ana.perez@example.com','moderator','user-b',NULL,'2026-09-04T00:00:00.000Z'),
      ('group-b','anaperez@example.com','admin','user-b',NULL,'2026-09-04T00:00:00.000Z');
  `);
  sqlite.exec(migration('0006_identity_ownership.sql'));
  const rows = sqlite.prepare('SELECT group_id,email,display_email,role,claimed_user_id FROM group_role_assignments ORDER BY group_id,email').all().map(row => ({ ...row }));
  assert.deepEqual(rows, [
    { group_id: 'group-a', email: 'ana.perez@example.com', display_email: 'ana.perez@example.com', role: 'moderator', claimed_user_id: null },
    { group_id: 'group-a', email: 'anaperez@gmail.com', display_email: 'anaperez@gmail.com', role: 'admin', claimed_user_id: 'user-a' },
    { group_id: 'group-b', email: 'anaperez@example.com', display_email: 'anaperez@example.com', role: 'admin', claimed_user_id: null }
  ]);
  const merge = sqlite.prepare('SELECT subject_email,old_role,new_role,reason,actor_user_id FROM role_events').all().map(row => ({ ...row }));
  assert.deepEqual(merge, [{ subject_email: 'anaperez@gmail.com', old_role: 'moderator', new_role: 'admin', reason: 'gmail_canonical_merge:ana.perez@gmail.com', actor_user_id: null }]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM group_role_assignments WHERE role='owner'").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM group_memberships WHERE role='owner'").get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
  assert.deepEqual({ ...sqlite.prepare("SELECT email,verified_email FROM identity_providers WHERE id='idp-1'").get() }, { email: 'anaperez@gmail.com', verified_email: 'Ana.Perez@gmail.com' });
  assert.equal(sqlite.prepare("SELECT email FROM identity_providers WHERE id='idp-2'").get().email, 'ana.perez@example.com');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM group_memberships').get().n, 3);
  assert.throws(() => sqlite.exec("UPDATE role_events SET reason='x'"), /append-only/);
  assert.throws(() => sqlite.exec('DELETE FROM role_events'), /append-only/);
  sqlite.exec("INSERT INTO group_role_assignments (group_id,email,display_email,role,assigned_by_user_id,created_at) VALUES ('group-b','one@example.com','one@example.com','owner','user-a','2026-10-01T00:00:00.000Z')");
  assert.throws(() => sqlite.exec("INSERT INTO group_role_assignments (group_id,email,display_email,role,assigned_by_user_id,created_at) VALUES ('group-b','two@example.com','two@example.com','owner','user-a','2026-10-01T00:00:00.000Z')"), /UNIQUE/);
});

test('dotted Gmail sign-in resolves the canonical assignment', async () => {
  const sqlite = legacyDatabase(); sqlite.exec(migration('0005_core_v6.sql')); sqlite.exec(migration('0006_identity_ownership.sql'));
  const db = adapter(sqlite);
  sqlite.exec("INSERT INTO group_role_assignments (group_id,email,display_email,role,assigned_by_user_id,created_at) VALUES ('group-a','anaperez@gmail.com','anaperez@gmail.com','moderator','user-a','2026-10-01T00:00:00.000Z')");
  const principal = await ensureAdminPrincipal(db, { sub: 'g-ana', email: 'Ana.Perez@Gmail.com' });
  assert.equal(principal.email, 'anaperez@gmail.com');
  assert.equal((await groupAuthority(db, principal, 'group-a', ['moderator'])).role, 'moderator');
  assert.equal(sqlite.prepare("SELECT verified_email FROM identity_providers WHERE subject='g-ana'").get().verified_email, 'Ana.Perez@Gmail.com');
  assert.equal(await ensureAdminPrincipal(db, { sub: 'g-other', email: 'ana.perez@example.com' }), null);
});

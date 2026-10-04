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
  const sqlite = legacyDatabase(); sqlite.exec(migration('0005_core_v6.sql'));
  const db = adapter(sqlite);
  const superadmin = await ensureAdminPrincipal(db, { sub: 'google-1', email: 'admin@example.com' }, ['admin@example.com']);
  assert.equal(superadmin.superadmin, true);
  assert.equal(await groupAuthority(db, superadmin, 'group-a', ['admin']), null);
  sqlite.prepare("INSERT INTO group_role_assignments (group_id,email,role,assigned_by_user_id,created_at) VALUES ('group-a','admin@example.com','admin',?,'2026-09-03T00:00:00.000Z')").run(superadmin.user_id);
  await ensureAdminPrincipal(db, { sub: 'google-1', email: 'admin@example.com' }, ['admin@example.com']);
  assert.equal((await groupAuthority(db, superadmin, 'group-a', ['admin'])).role, 'admin');
  assert.equal(await groupAuthority(db, superadmin, 'group-b', ['admin']), null);
  assert.equal(sqlite.prepare("SELECT role FROM global_roles WHERE user_id=?").get(superadmin.user_id).role, 'superadmin');
});

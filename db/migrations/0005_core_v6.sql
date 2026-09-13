-- Additive bridge from the Sprint 2 prototype to the v6 core model.
-- Legacy tables and columns remain available while endpoints are migrated.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deletion_pending','deleted')),
  created_at TEXT NOT NULL,
  deletion_requested_at TEXT
);

INSERT INTO users (id,created_at)
SELECT id,created_at FROM publishers;

ALTER TABLE publishers ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE publishers SET user_id=id WHERE user_id IS NULL;
CREATE INDEX publishers_user ON publishers(user_id);

CREATE TABLE identity_providers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK(provider IN ('google')),
  subject TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider,subject),
  UNIQUE(provider,email)
);
CREATE INDEX identity_providers_user ON identity_providers(user_id);

CREATE TABLE global_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('superadmin')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id,role)
);

CREATE TABLE group_memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  par_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','moderator','admin')),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','suspended','blocked','left')),
  trust INTEGER NOT NULL DEFAULT 0 CHECK(trust IN (0,1)),
  joined_at TEXT NOT NULL,
  suspended_until TEXT,
  blocked_at TEXT,
  PRIMARY KEY (user_id,group_id),
  UNIQUE (group_id,par_id)
);
CREATE INDEX group_memberships_group_role ON group_memberships(group_id,role,state);

INSERT INTO group_memberships (user_id,group_id,par_id,state,trust,joined_at)
SELECT p.user_id,m.group_id,lower(hex(randomblob(16))),
       CASE WHEN m.status='BLOCKED' THEN 'blocked' ELSE 'active' END,
       CASE WHEN m.status='TRUSTED' THEN 1 ELSE 0 END,
       p.created_at
FROM memberships m JOIN publishers p ON p.id=m.publisher_id;

ALTER TABLE groups ADD COLUMN identity_mode TEXT NOT NULL DEFAULT 'identified'
  CHECK(identity_mode IN ('identified','anonymous'));
ALTER TABLE groups ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Atlantic/Canary';
ALTER TABLE groups ADD COLUMN retention_days INTEGER CHECK(retention_days IS NULL OR retention_days > 0);
ALTER TABLE groups ADD COLUMN wall_lifetime_days INTEGER CHECK(wall_lifetime_days IS NULL OR wall_lifetime_days > 0);
ALTER TABLE groups ADD COLUMN capacity_bytes INTEGER CHECK(capacity_bytes IS NULL OR capacity_bytes > 0);
ALTER TABLE groups ADD COLUMN seat_limit INTEGER CHECK(seat_limit IS NULL OR seat_limit > 0);
ALTER TABLE groups ADD COLUMN operational_state TEXT NOT NULL DEFAULT 'active'
  CHECK(operational_state IN ('active','capacity_frozen','suspended','payment_pending','deletion_pending','closed'));

ALTER TABLE photos ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE photos ADD COLUMN par_id TEXT;
ALTER TABLE photos ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'group'
  CHECK(origin_type IN ('group','user'));
ALTER TABLE photos ADD COLUMN published_at TEXT;
ALTER TABLE photos ADD COLUMN storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK(storage_bytes >= 0);

UPDATE photos SET user_id=publisher_id WHERE publisher_id IS NOT NULL;
UPDATE photos
SET par_id=(SELECT gm.par_id FROM group_memberships gm
            WHERE gm.user_id=photos.user_id AND gm.group_id=photos.group_id)
WHERE group_id IS NOT NULL AND user_id IS NOT NULL;
UPDATE photos SET published_at=created_at WHERE status='published' AND published_at IS NULL;
CREATE INDEX photos_user ON photos(user_id,created_at DESC,id DESC);
CREATE INDEX photos_par ON photos(group_id,par_id,created_at DESC,id DESC);

CREATE TABLE walls (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  arrangement_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(group_id,id)
);
CREATE UNIQUE INDEX one_open_wall_per_group ON walls(group_id) WHERE state='open';

INSERT INTO walls (id,group_id,name,opened_at)
SELECT 'initial-' || id,id,name,created_at FROM groups;

CREATE TABLE wall_photos (
  wall_id TEXT NOT NULL REFERENCES walls(id),
  photo_id TEXT NOT NULL REFERENCES photos(id),
  position INTEGER NOT NULL CHECK(position >= 0),
  added_at TEXT NOT NULL,
  PRIMARY KEY (wall_id,photo_id),
  UNIQUE (wall_id,position)
);

INSERT INTO wall_photos (wall_id,photo_id,position,added_at)
SELECT 'initial-' || p.group_id,p.id,
       ROW_NUMBER() OVER (PARTITION BY p.group_id ORDER BY p.created_at,p.id) - 1,
       COALESCE(p.published_at,p.created_at)
FROM photos p
WHERE p.group_id IS NOT NULL AND p.status='published';

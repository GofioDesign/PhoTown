-- Sprint 2 v6: canonical Gmail identity, group ownership and an append-only role audit.
-- No owner is promoted here: each group gets its first owner through the superadmin bootstrap.
PRAGMA defer_foreign_keys = true;

CREATE TABLE role_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  actor_user_id TEXT REFERENCES users(id),
  subject_email TEXT NOT NULL,
  old_role TEXT CHECK(old_role IS NULL OR old_role IN ('user','moderator','admin','owner')),
  new_role TEXT CHECK(new_role IS NULL OR new_role IN ('user','moderator','admin','owner')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX role_events_group ON role_events(group_id,created_at);
CREATE TRIGGER role_events_no_update BEFORE UPDATE ON role_events
BEGIN SELECT RAISE(ABORT,'role_events is append-only'); END;
CREATE TRIGGER role_events_no_delete BEFORE DELETE ON role_events
BEGIN SELECT RAISE(ABORT,'role_events is append-only'); END;

-- Group role assignments keyed by canonical email; the original address is kept for display.
CREATE TABLE group_role_assignments_v6 (
  group_id TEXT NOT NULL REFERENCES groups(id),
  email TEXT NOT NULL,
  display_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('moderator','admin','owner')),
  assigned_by_user_id TEXT NOT NULL REFERENCES users(id),
  claimed_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id,email)
);

CREATE TABLE assignment_candidates AS
SELECT group_id,
       CASE WHEN lower(trim(email)) LIKE '%@gmail.com'
            THEN replace(substr(lower(trim(email)),1,instr(lower(trim(email)),'@')-1),'.','') || '@gmail.com'
            ELSE lower(trim(email)) END AS canonical,
       email AS display_email,role,assigned_by_user_id,claimed_user_id,created_at,
       ROW_NUMBER() OVER (
         PARTITION BY group_id,
           CASE WHEN lower(trim(email)) LIKE '%@gmail.com'
                THEN replace(substr(lower(trim(email)),1,instr(lower(trim(email)),'@')-1),'.','') || '@gmail.com'
                ELSE lower(trim(email)) END
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                  CASE WHEN claimed_user_id IS NULL THEN 1 ELSE 0 END,
                  created_at,email
       ) AS rank
FROM group_role_assignments;

INSERT INTO group_role_assignments_v6 (group_id,email,display_email,role,assigned_by_user_id,claimed_user_id,created_at)
SELECT c.group_id,c.canonical,c.display_email,c.role,c.assigned_by_user_id,
       COALESCE(c.claimed_user_id,(SELECT d.claimed_user_id FROM assignment_candidates d
         WHERE d.group_id=c.group_id AND d.canonical=c.canonical AND d.claimed_user_id IS NOT NULL ORDER BY d.rank LIMIT 1)),
       c.created_at
FROM assignment_candidates c WHERE c.rank=1;

INSERT INTO role_events (id,group_id,actor_user_id,subject_email,old_role,new_role,reason,created_at)
SELECT lower(hex(randomblob(16))),d.group_id,NULL,d.canonical,d.role,w.role,
       'gmail_canonical_merge:' || d.display_email,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM assignment_candidates d
JOIN assignment_candidates w ON w.group_id=d.group_id AND w.canonical=d.canonical AND w.rank=1
WHERE d.rank>1;

DROP TABLE assignment_candidates;
DROP TABLE group_role_assignments;
ALTER TABLE group_role_assignments_v6 RENAME TO group_role_assignments;
CREATE INDEX group_role_assignments_email ON group_role_assignments(email,group_id);
CREATE UNIQUE INDEX one_owner_assignment_per_group ON group_role_assignments(group_id) WHERE role='owner';

-- Memberships gain the owner role; keys and PAR-IDs are copied unchanged.
CREATE TABLE group_memberships_v6 (
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  par_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','moderator','admin','owner')),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','suspended','blocked','left')),
  trust INTEGER NOT NULL DEFAULT 0 CHECK(trust IN (0,1)),
  joined_at TEXT NOT NULL,
  suspended_until TEXT,
  blocked_at TEXT,
  PRIMARY KEY (user_id,group_id),
  UNIQUE (group_id,par_id)
);
INSERT INTO group_memberships_v6 (user_id,group_id,par_id,role,state,trust,joined_at,suspended_until,blocked_at)
SELECT user_id,group_id,par_id,role,state,trust,joined_at,suspended_until,blocked_at FROM group_memberships;
DROP TABLE group_memberships;
ALTER TABLE group_memberships_v6 RENAME TO group_memberships;
CREATE INDEX group_memberships_group_role ON group_memberships(group_id,role,state);
CREATE UNIQUE INDEX one_owner_membership_per_group ON group_memberships(group_id) WHERE role='owner';

-- Identity providers: canonical email for lookups, verified original for display, room for email sign-in.
CREATE TABLE identity_providers_v6 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK(provider IN ('google','email')),
  subject TEXT NOT NULL,
  email TEXT,
  verified_email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider,subject),
  UNIQUE(provider,email)
);
INSERT INTO identity_providers_v6 (id,user_id,provider,subject,email,verified_email,created_at)
SELECT id,user_id,provider,subject,
       CASE WHEN email IS NULL THEN NULL
            WHEN lower(trim(email)) LIKE '%@gmail.com'
            THEN replace(substr(lower(trim(email)),1,instr(lower(trim(email)),'@')-1),'.','') || '@gmail.com'
            ELSE lower(trim(email)) END,
       email,created_at
FROM identity_providers;
DROP TABLE identity_providers;
ALTER TABLE identity_providers_v6 RENAME TO identity_providers;
CREATE INDEX identity_providers_user ON identity_providers(user_id);

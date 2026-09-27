-- Email accounts with passwordless login, invitations by email, multi-device sessions.
ALTER TABLE publishers ADD COLUMN email TEXT CHECK(email IS NULL OR length(email) <= 254);
CREATE UNIQUE INDEX publishers_email ON publishers(email) WHERE email IS NOT NULL;
ALTER TABLE publishers ADD COLUMN email_digest INTEGER NOT NULL DEFAULT 1 CHECK(email_digest IN (0,1));
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_publisher ON sessions(publisher_id);
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_tokens_email ON login_tokens(email, created_at);
CREATE TABLE invitations (
  group_id TEXT NOT NULL REFERENCES groups(id),
  email TEXT NOT NULL CHECK(length(email) <= 254),
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  accepted_at TEXT,
  PRIMARY KEY (group_id, email)
);
CREATE INDEX invitations_email ON invitations(email);

-- Storage: JPEG fallback, wall thumbnails, challenges, administrator notices.
ALTER TABLE photos ADD COLUMN content_type TEXT NOT NULL DEFAULT 'image/webp' CHECK(content_type IN ('image/webp','image/jpeg'));
ALTER TABLE photos ADD COLUMN thumb_key TEXT;
ALTER TABLE photos ADD COLUMN challenge_id TEXT;
ALTER TABLE photos ADD COLUMN admin_notified_at TEXT;
UPDATE photos SET admin_notified_at=created_at WHERE status='pending';
CREATE INDEX photos_challenge ON photos(challenge_id,status,created_at DESC,id DESC);
CREATE INDEX photos_admin_notice ON photos(status,admin_notified_at);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  title TEXT NOT NULL CHECK(length(title) <= 80),
  prompt TEXT NOT NULL DEFAULT '' CHECK(length(prompt) <= 1000),
  grid TEXT NOT NULL DEFAULT 'none' CHECK(grid IN ('none','thirds','phi','spiral','diagonals','center')),
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX challenges_group ON challenges(group_id,active,created_at DESC);

CREATE TABLE reactions (
  photo_id TEXT NOT NULL REFERENCES photos(id),
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  kind TEXT NOT NULL CHECK(kind IN ('like','light','composition','idea')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (photo_id,publisher_id,kind)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  group_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('photo','reaction','approved','challenge')),
  photo_id TEXT,
  challenge_id TEXT,
  actor TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  read_at TEXT,
  emailed_at TEXT
);
CREATE INDEX notifications_inbox ON notifications(publisher_id,created_at DESC,id DESC);
CREATE INDEX notifications_email ON notifications(emailed_at,publisher_id);

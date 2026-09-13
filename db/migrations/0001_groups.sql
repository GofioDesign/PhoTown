CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE publishers (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE memberships (
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','MODERATED','TRUSTED','BLOCKED')),
  PRIMARY KEY (publisher_id,group_id)
);
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  publisher_id TEXT REFERENCES publishers(id),
  group_id TEXT REFERENCES groups(id),
  image_key TEXT NOT NULL UNIQUE,
  sha256 TEXT,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('uploading','pending','published','hidden','deleting','deleted')),
  week TEXT,
  cleaned_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX photos_owner ON photos(group_id,publisher_id,created_at DESC,id DESC);
CREATE INDEX photos_wall ON photos(group_id,status,created_at DESC,id DESC);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

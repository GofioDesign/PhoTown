-- Group invitations sent by email. The link signs the person in and links the address
-- to their USER, so afterwards they can also enter with «Entrar con mi correo».
CREATE TABLE group_invitations (
  token_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  email TEXT NOT NULL,
  display_email TEXT NOT NULL,
  invited_by_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_user_id TEXT REFERENCES users(id)
);
CREATE INDEX group_invitations_group ON group_invitations(group_id,email,created_at);

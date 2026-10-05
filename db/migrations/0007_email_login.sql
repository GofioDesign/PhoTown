-- Sign-in by email: one-use links and codes, and per-device sessions.
-- An email address is linked to a USER as identity_providers(provider='email').

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK(purpose IN ('link','login')),
  email TEXT NOT NULL,
  display_email TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK(purpose = 'login' OR user_id IS NOT NULL)
);
CREATE INDEX login_tokens_email ON login_tokens(email,purpose,created_at);

CREATE TABLE device_sessions (
  token_hash TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX device_sessions_publisher ON device_sessions(publisher_id);

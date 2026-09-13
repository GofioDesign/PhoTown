CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK(length(email) <= 254),
  created_at TEXT NOT NULL
);
CREATE INDEX waitlist_created ON waitlist(created_at DESC, id DESC);

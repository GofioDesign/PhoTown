-- Display rotation set by a group's moderators, and composition challenges per group.
-- Rotation is metadata only: the stored image is never re-encoded.
ALTER TABLE photos ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0 CHECK(rotation IN (0,90,180,270));

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  prompt TEXT NOT NULL DEFAULT '' CHECK(length(prompt) <= 1000),
  grid TEXT NOT NULL DEFAULT 'none' CHECK(grid IN ('none','thirds','phi','spiral','diagonals','center')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX challenges_group ON challenges(group_id,active,created_at DESC);

ALTER TABLE photos ADD COLUMN challenge_id TEXT REFERENCES challenges(id);
CREATE INDEX photos_challenge ON photos(challenge_id,status,created_at DESC,id DESC);

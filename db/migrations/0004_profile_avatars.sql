CREATE TABLE profile_avatars (
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  image BLOB NOT NULL CHECK(length(image) <= 131072),
  PRIMARY KEY (publisher_id, group_id)
);

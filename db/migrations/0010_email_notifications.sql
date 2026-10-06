-- Email notifications: a digest of new photos for wall members and a reminder of the
-- pending moderation queue for a group's owner, admins and moderators.
-- A missing preferences row means the defaults: weekly digest, moderation reminder on.
CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  digest TEXT NOT NULL DEFAULT 'weekly' CHECK(digest IN ('off','daily','weekly')),
  moderation INTEGER NOT NULL DEFAULT 1 CHECK(moderation IN (0,1)),
  updated_at TEXT NOT NULL
);

-- One row per message sent, so a retried or overlapping cron never sends twice.
CREATE TABLE notification_deliveries (
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('daily','weekly','moderation')),
  period TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (user_id,kind,period)
);
CREATE INDEX notification_deliveries_sent ON notification_deliveries(sent_at);

CREATE INDEX photos_group_published ON photos(group_id,status,published_at);

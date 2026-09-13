ALTER TABLE memberships ADD COLUMN alias TEXT NOT NULL DEFAULT '' CHECK(length(alias) <= 40);

ALTER TABLE users
  ADD COLUMN avatar_upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL;

CREATE INDEX users_avatar_upload
  ON users(avatar_upload_id)
  WHERE avatar_upload_id IS NOT NULL;

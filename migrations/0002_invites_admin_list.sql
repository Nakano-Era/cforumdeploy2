CREATE INDEX IF NOT EXISTS invites_admin_created
  ON invites(created_at DESC, id DESC);

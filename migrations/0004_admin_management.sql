CREATE INDEX IF NOT EXISTS users_admin_directory
  ON users(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS users_active_role
  ON users(role, status, id);

-- Keep at least one usable administrator even when a future code path edits
-- users directly instead of going through the management API.
CREATE TRIGGER IF NOT EXISTS users_preserve_last_active_admin_update
BEFORE UPDATE OF role, status ON users
WHEN OLD.role = 'admin'
  AND OLD.status = 'active'
  AND (NEW.role != 'admin' OR NEW.status != 'active')
  AND NOT EXISTS (
    SELECT 1 FROM users
    WHERE id != OLD.id AND role = 'admin' AND status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'last_active_admin_required');
END;

CREATE TRIGGER IF NOT EXISTS users_preserve_last_active_admin_delete
BEFORE DELETE ON users
WHEN OLD.role = 'admin'
  AND OLD.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM users
    WHERE id != OLD.id AND role = 'admin' AND status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'last_active_admin_required');
END;

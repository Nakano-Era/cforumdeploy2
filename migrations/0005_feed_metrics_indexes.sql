-- Feed pulse metrics run on every feed request. These range-first indexes
-- keep presence and seven-day activity queries from scanning full histories.
CREATE INDEX IF NOT EXISTS sessions_presence_recent
  ON sessions(last_seen_at DESC, expires_at, user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS user_activity_daily_active_date
  ON user_activity_daily(activity_date, user_id)
  WHERE active = 1;

PRAGMA foreign_keys = ON;

CREATE TABLE site_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE bootstrap_claim (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  claimed_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  trust_level INTEGER NOT NULL DEFAULT 0 CHECK (trust_level BETWEEN 0 AND 4),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'silenced', 'suspended', 'deleted')),
  level_locked INTEGER NOT NULL DEFAULT 0 CHECK (level_locked IN (0, 1)),
  next_level_review_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX users_level_review_due
  ON users(COALESCE(next_level_review_at, 0), id)
  WHERE level_locked = 0
    AND trust_level < 4
    AND status IN ('active', 'silenced');

CREATE TABLE user_emails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL COLLATE NOCASE UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  verified_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX user_emails_one_primary
  ON user_emails(user_id) WHERE is_primary = 1;

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  transports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports_json)),
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX passkeys_user_id ON passkeys(user_id);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  challenge_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX webauthn_challenges_expiry
  ON webauthn_challenges(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  device_label TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX sessions_user_active
  ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE email_verifications (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE,
  email_normalized TEXT NOT NULL COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'recovery', 'change_email', 'security_action')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'sent', 'verified', 'failed', 'expired', 'invalidated')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  resend_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX email_verifications_lookup
  ON email_verifications(email_normalized, purpose, created_at DESC);

CREATE TABLE registration_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  email_normalized TEXT NOT NULL COLLATE NOCASE,
  username TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  invite_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('email_pending', 'pending_review', 'needs_info', 'approved', 'rejected', 'cancelled')),
  submitted_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT
);

CREATE INDEX registration_requests_status
  ON registration_requests(status, submitted_at, id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  email_hash TEXT,
  allowed_domain TEXT COLLATE NOCASE,
  max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at INTEGER,
  revoked_at INTEGER,
  auto_group_id TEXT,
  redirect_topic_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK (used_count <= max_uses)
);

CREATE INDEX invites_creator_created ON invites(created_by, created_at DESC);

CREATE TABLE invite_uses (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES invites(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  email_hash TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  UNIQUE(invite_id, user_id)
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'members', 'staff')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_members_user ON group_members(user_id, group_id);

CREATE TABLE trust_level_rules (
  level INTEGER PRIMARY KEY CHECK (level BETWEEN 1 AND 4),
  rule_json TEXT NOT NULL CHECK (json_valid(rule_json)),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_activity_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_date TEXT NOT NULL,
  topics_entered INTEGER NOT NULL DEFAULT 0,
  posts_read INTEGER NOT NULL DEFAULT 0,
  reading_seconds INTEGER NOT NULL DEFAULT 0,
  replies_created INTEGER NOT NULL DEFAULT 0,
  distinct_topics_replied INTEGER NOT NULL DEFAULT 0,
  likes_given INTEGER NOT NULL DEFAULT 0,
  likes_received INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  PRIMARY KEY (user_id, activity_date)
);

CREATE TABLE user_activity_rollups (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  window_days INTEGER NOT NULL CHECK (window_days IN (7, 30, 90, 100, 180)),
  as_of_date TEXT NOT NULL,
  metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, window_days)
);

CREATE TABLE user_level_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_level INTEGER NOT NULL CHECK (from_level BETWEEN 0 AND 4),
  to_level INTEGER NOT NULL CHECK (to_level BETWEEN 0 AND 4),
  reason TEXT NOT NULL,
  metrics_snapshot_json TEXT NOT NULL CHECK (json_valid(metrics_snapshot_json)),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX user_level_history_user ON user_level_history(user_id, created_at DESC);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#737373',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'deleted')),
  acl_mode TEXT NOT NULL DEFAULT 'restricted' CHECK (acl_mode IN ('open', 'restricted')),
  min_view_level INTEGER NOT NULL DEFAULT 0 CHECK (min_view_level BETWEEN 0 AND 4),
  min_create_level INTEGER NOT NULL DEFAULT 0 CHECK (min_create_level BETWEEN 0 AND 4),
  min_reply_level INTEGER NOT NULL DEFAULT 0 CHECK (min_reply_level BETWEEN 0 AND 4),
  allowed_topic_min_level_max INTEGER NOT NULL DEFAULT 4 CHECK (allowed_topic_min_level_max BETWEEN 0 AND 4),
  require_topic_approval INTEGER NOT NULL DEFAULT 0 CHECK (require_topic_approval IN (0, 1)),
  require_reply_approval INTEGER NOT NULL DEFAULT 0 CHECK (require_reply_approval IN (0, 1)),
  allow_images INTEGER NOT NULL DEFAULT 1 CHECK (allow_images IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX categories_parent_position ON categories(parent_id, position, id);

CREATE TABLE category_permissions (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('everyone', 'authenticated', 'group')),
  principal_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('see', 'reply', 'create')),
  created_at INTEGER NOT NULL,
  CHECK (
    (principal_type = 'group' AND principal_id IS NOT NULL) OR
    (principal_type != 'group' AND principal_id IS NULL)
  )
);

CREATE UNIQUE INDEX category_permissions_unique
  ON category_permissions(category_id, principal_type, COALESCE(principal_id, ''), action);

CREATE INDEX category_permissions_group ON category_permissions(principal_id, category_id);

CREATE TABLE moderator_category_scopes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  assigned_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, category_id)
);

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  content_shard_id INTEGER NOT NULL DEFAULT 0,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  min_view_level INTEGER NOT NULL DEFAULT 0 CHECK (min_view_level BETWEEN 0 AND 4),
  effective_min_view_level INTEGER NOT NULL DEFAULT 0 CHECK (effective_min_view_level BETWEEN 0 AND 4),
  author_qualified_visibility_level INTEGER NOT NULL DEFAULT 0 CHECK (author_qualified_visibility_level BETWEEN 0 AND 4),
  author_downgrade_locked INTEGER NOT NULL DEFAULT 0 CHECK (author_downgrade_locked IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'archived', 'deleted', 'pending')),
  manual_lock_reason TEXT,
  approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  pinned_at INTEGER,
  featured_at INTEGER,
  slow_mode_seconds INTEGER NOT NULL DEFAULT 0 CHECK (slow_mode_seconds >= 0),
  reply_count INTEGER NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  unique_replier_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_replier_count >= 0),
  hot_score REAL NOT NULL DEFAULT 0,
  last_post_number INTEGER NOT NULL DEFAULT 1 CHECK (last_post_number >= 1),
  bumped_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(category_id, slug)
);

CREATE INDEX topics_feed
  ON topics(effective_min_view_level, bumped_at DESC, id DESC)
  WHERE status IN ('open', 'locked', 'archived') AND approval_status = 'approved';
CREATE INDEX topics_category_feed
  ON topics(category_id, effective_min_view_level, bumped_at DESC, id DESC)
  WHERE status IN ('open', 'locked', 'archived') AND approval_status = 'approved';
CREATE INDEX topics_hot
  ON topics(effective_min_view_level, hot_score DESC, id DESC)
  WHERE status IN ('open', 'locked', 'archived') AND approval_status = 'approved';
CREATE INDEX topics_author ON topics(author_id, created_at DESC, id DESC);
CREATE INDEX topics_trust_window
  ON topics(created_at, category_id, effective_min_view_level, id)
  WHERE status IN ('open', 'locked', 'archived')
    AND approval_status = 'approved';

CREATE TRIGGER users_topics_author_downgrade_lock
AFTER UPDATE OF trust_level ON users
WHEN OLD.trust_level != NEW.trust_level
BEGIN
  UPDATE topics
  SET
    author_downgrade_locked = CASE
      WHEN NEW.trust_level < MAX(
        (SELECT min_view_level FROM categories WHERE id = topics.category_id),
        topics.min_view_level,
        topics.effective_min_view_level
      )
      AND MAX(
        (SELECT min_view_level FROM categories WHERE id = topics.category_id),
        topics.min_view_level,
        topics.effective_min_view_level
      ) <= topics.author_qualified_visibility_level
      THEN 1
      ELSE 0
    END,
    updated_at = unixepoch()
  WHERE author_id = NEW.id AND status != 'deleted';
END;

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  content_shard_id INTEGER NOT NULL DEFAULT 0,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  post_number INTEGER NOT NULL CHECK (post_number > 0),
  raw_markdown TEXT NOT NULL,
  plain_text_excerpt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('pending', 'published', 'hidden', 'deleted')),
  reply_to_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  edit_count INTEGER NOT NULL DEFAULT 0 CHECK (edit_count >= 0),
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(topic_id, post_number)
);

CREATE INDEX posts_topic_page ON posts(topic_id, post_number, id);
CREATE INDEX posts_author ON posts(author_id, created_at DESC, id DESC);
CREATE INDEX posts_trust_window
  ON posts(created_at, topic_id, post_number)
  WHERE status = 'published';

CREATE TABLE post_revisions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  raw_markdown TEXT NOT NULL,
  edit_reason TEXT,
  edited_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE(post_id, revision_number)
);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_key TEXT NOT NULL,
  raw_markdown TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  client_revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, draft_key)
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  topic_count INTEGER NOT NULL DEFAULT 0 CHECK (topic_count >= 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE topic_tags (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, tag_id)
);

CREATE INDEX topic_tags_tag ON topic_tags(tag_id, topic_id);

CREATE TABLE reactions (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction_type TEXT NOT NULL DEFAULT 'like',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id, reaction_type)
);

CREATE INDEX reactions_user ON reactions(user_id, created_at DESC);

CREATE TRIGGER reactions_trust_activity_insert
AFTER INSERT ON reactions
WHEN NEW.reaction_type = 'like'
  AND EXISTS (
    SELECT 1 FROM posts
    WHERE id = NEW.post_id
      AND author_id != NEW.user_id
      AND status = 'published'
  )
BEGIN
  INSERT INTO user_activity_daily(
    user_id, activity_date, likes_given, active
  ) VALUES (NEW.user_id, date(NEW.created_at, 'unixepoch'), 1, 1)
  ON CONFLICT(user_id, activity_date) DO UPDATE SET
    likes_given = likes_given + 1,
    active = 1;

  INSERT INTO user_activity_daily(
    user_id, activity_date, likes_received
  )
  SELECT author_id, date(NEW.created_at, 'unixepoch'), 1
  FROM posts WHERE id = NEW.post_id
  ON CONFLICT(user_id, activity_date) DO UPDATE SET
    likes_received = likes_received + 1;
END;

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  label TEXT,
  reminder_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, topic_id, post_id)
);

CREATE INDEX bookmarks_user ON bookmarks(user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX bookmarks_identity
  ON bookmarks(user_id, topic_id, COALESCE(post_id, ''));

CREATE TABLE topic_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  last_read_post_number INTEGER NOT NULL DEFAULT 0 CHECK (last_read_post_number >= 0),
  first_read_at INTEGER NOT NULL,
  last_read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id)
);

CREATE INDEX topic_reads_unread ON topic_reads(user_id, last_read_at DESC);

CREATE TABLE topic_follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('watch', 'track', 'watch_first_post', 'normal', 'mute')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id)
);

CREATE TABLE category_follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('watch', 'track', 'watch_first_post', 'normal', 'mute')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, category_id)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE,
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE INDEX notifications_user_unread
  ON notifications(user_id, read_at, created_at DESC, id DESC);
CREATE INDEX notifications_trust_email_pending
  ON notifications(created_at, id)
  WHERE kind IN (
    'trust_level_promoted',
    'trust_level_demotion_warning',
    'trust_level_demoted'
  )
    AND json_extract(data_json, '$.emailQueuedAt') IS NULL;

CREATE TABLE badges (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT NOT NULL,
  grant_kind TEXT NOT NULL CHECK (grant_kind IN ('automatic', 'manual', 'both')),
  rule_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE user_badges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  related_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX user_badges_user ON user_badges(user_id, granted_at DESC);

CREATE TABLE upload_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes > 0),
  object_count INTEGER NOT NULL CHECK (object_count > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'finalized', 'expired', 'cancelled')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX upload_reservations_active
  ON upload_reservations(user_id, expires_at) WHERE status = 'active';

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  reservation_id TEXT REFERENCES upload_reservations(id) ON DELETE SET NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  topic_id TEXT REFERENCES topics(id) ON DELETE RESTRICT,
  post_id TEXT REFERENCES posts(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (scope IN ('temporary', 'public', 'private')),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'uploaded', 'bound', 'quarantined', 'deleted')),
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER CHECK (width > 0),
  height INTEGER CHECK (height > 0),
  min_view_level INTEGER NOT NULL DEFAULT 0 CHECK (min_view_level BETWEEN 0 AND 4),
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  bound_at INTEGER,
  deleted_at INTEGER,
  CHECK ((topic_id IS NULL AND post_id IS NULL) OR topic_id IS NOT NULL)
);

CREATE INDEX uploads_topic ON uploads(topic_id, state, id);
CREATE INDEX uploads_owner_created ON uploads(owner_user_id, created_at DESC);
CREATE INDEX uploads_lifecycle ON uploads(state, created_at);

CREATE TABLE upload_variants (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('main', 'thumbnail', 'avatar', 'original')),
  object_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at INTEGER NOT NULL,
  UNIQUE(upload_id, kind)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE RESTRICT,
  report_type TEXT NOT NULL CHECK (report_type IN ('off_topic', 'inappropriate', 'spam', 'illegal', 'other')),
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE(reporter_user_id, target_post_id, report_type)
);

CREATE INDEX reports_status ON reports(status, created_at, id);

CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('registration', 'first_post', 'media_post', 'report')),
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  target_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  trigger_reason TEXT NOT NULL,
  content_snapshot_json TEXT NOT NULL CHECK (json_valid(content_snapshot_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'approved', 'rejected', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT,
  internal_note TEXT,
  created_at INTEGER NOT NULL,
  handled_at INTEGER
);

CREATE INDEX review_items_queue ON review_items(status, priority DESC, created_at, id);
CREATE INDEX review_items_category ON review_items(category_id, status, created_at);

CREATE TABLE moderation_actions (
  id TEXT PRIMARY KEY,
  review_item_id TEXT REFERENCES review_items(id) ON DELETE SET NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  target_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL
);

CREATE INDEX moderation_actions_target_user
  ON moderation_actions(target_user_id, created_at DESC);

CREATE TABLE usage_counters (
  resource TEXT NOT NULL,
  period_key TEXT NOT NULL,
  counter_key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (resource, period_key, counter_key)
);

CREATE TABLE rate_limit_buckets (
  key_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key_hash, action, period_start)
);

CREATE INDEX rate_limit_buckets_expiry ON rate_limit_buckets(expires_at);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  ip_hash TEXT,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);

CREATE INDEX audit_logs_time ON audit_logs(occurred_at DESC, id DESC);
CREATE INDEX audit_logs_target ON audit_logs(target_type, target_id, occurred_at DESC);

CREATE VIRTUAL TABLE post_search USING fts5(
  post_id UNINDEXED,
  topic_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER posts_search_insert
AFTER INSERT ON posts
WHEN NEW.status = 'published'
BEGIN
  INSERT INTO post_search(rowid, post_id, topic_id, title, body)
  VALUES (
    NEW.rowid,
    NEW.id,
    NEW.topic_id,
    CASE
      WHEN NEW.post_number = 1
      THEN (SELECT title FROM topics WHERE id = NEW.topic_id)
      ELSE ''
    END,
    NEW.raw_markdown
  );
END;

CREATE TRIGGER posts_search_update
AFTER UPDATE OF raw_markdown, status ON posts
BEGIN
  DELETE FROM post_search WHERE rowid = OLD.rowid;
  INSERT INTO post_search(rowid, post_id, topic_id, title, body)
  SELECT
    NEW.rowid,
    NEW.id,
    NEW.topic_id,
    CASE
      WHEN NEW.post_number = 1
      THEN (SELECT title FROM topics WHERE id = NEW.topic_id)
      ELSE ''
    END,
    NEW.raw_markdown
  WHERE NEW.status = 'published';
END;

CREATE TRIGGER topics_search_title_update
AFTER UPDATE OF title ON topics
BEGIN
  UPDATE post_search
  SET title = NEW.title
  WHERE topic_id = NEW.id
    AND post_id = (
      SELECT id FROM posts
      WHERE topic_id = NEW.id AND post_number = 1
      LIMIT 1
    );
END;

CREATE TRIGGER posts_search_delete
AFTER DELETE ON posts
BEGIN
  DELETE FROM post_search WHERE rowid = OLD.rowid;
END;

INSERT INTO site_settings(key, value_json, is_public, updated_at) VALUES
  ('site_name', '"CForum"', 1, unixepoch()),
  ('site_description', '"认真交流的地方"', 1, unixepoch()),
  ('registration_mode', '"approval"', 1, unixepoch()),
  ('invite_requires_approval', 'false', 0, unixepoch()),
  ('registration_frozen', 'false', 1, unixepoch()),
  ('disabled_email_domains', '[]', 0, unixepoch()),
  ('maintenance_mode', 'false', 1, unixepoch()),
  ('installation_completed', 'false', 0, unixepoch()),
  ('lv0_first_topics_review_count', '3', 0, unixepoch()),
  ('lv0_first_replies_review_count', '3', 0, unixepoch()),
  ('r2_soft_limit_bytes', '7516192768', 0, unixepoch()),
  ('r2_hard_limit_bytes', '8589934592', 0, unixepoch()),
  ('private_originals_enabled', 'false', 0, unixepoch()),
  ('private_original_retention_days', '7', 0, unixepoch());

INSERT INTO trust_level_rules(level, rule_json, updated_at) VALUES
  (1, '{"topicsEntered":5,"postsRead":30,"readingSeconds":600}', unixepoch()),
  (2, '{"topicsEntered":20,"postsRead":100,"readingSeconds":3600,"visitDays":15,"distinctTopicsReplied":3,"likesGiven":1,"likesReceived":1,"demoteAfterInactiveDays":90,"warningDays":14}', unixepoch()),
  (3, '{"windowDays":100,"topicPercent":25,"topicCap":500,"postPercent":25,"postCap":20000,"distinctTopicsReplied":10,"readingDays":50,"likesGiven":30,"likesReceived":20,"likeGiverCount":5,"likeDayCount":7,"maxConfirmedSevereReports":0,"sanctionFreeDays":180,"graceDays":14,"demotionRatio":0.9}', unixepoch()),
  (4, '{"manualOnly":true}', unixepoch());

INSERT INTO badges(id, slug, name, description, icon, grant_kind, rule_key, created_at) VALUES
  ('badge-first-post', 'first-post', '初次发言', '发布第一篇内容', '✦', 'automatic', 'first_post', unixepoch()),
  ('badge-first-like', 'first-like', '初获认同', '第一次获得点赞', '♥', 'automatic', 'first_like', unixepoch()),
  ('badge-visit-streak', 'visit-streak', '常来看看', '连续访问社区', '◷', 'automatic', 'visit_streak', unixepoch()),
  ('badge-helpful', 'helpful', '热心回复', '持续帮助其他成员', '✺', 'automatic', 'helpful_replies', unixepoch()),
  ('badge-quality', 'quality', '优质贡献', '贡献获得社区认可', '◆', 'both', 'quality_contribution', unixepoch()),
  ('badge-inviter', 'inviter', '引路人', '发出的邀请被有效使用', '↗', 'automatic', 'effective_invite', unixepoch()),
  ('badge-fifty-likes', 'fifty-likes', '五十赞', '累计获得五十次点赞', '●', 'automatic', 'fifty_likes', unixepoch()),
  ('badge-veteran', 'veteran', '社区元老', '长期参与社区建设', '◇', 'both', 'community_veteran', unixepoch());

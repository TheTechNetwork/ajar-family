/**
 * SQLite schema (dialect shared by node:sqlite for a Node host and Cloudflare D1
 * for Workers). Complex fields (scope, arrays, JSON blobs) are stored as TEXT.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
  password_hash TEXT, token_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reset_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_reset_hash ON password_reset_tokens(token_hash);
CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
  assigned_child_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memberships_family ON memberships(family_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);

CREATE TABLE IF NOT EXISTS children (
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL, display_name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_children_family ON children(family_id);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL, child_id TEXT NOT NULL, platform TEXT NOT NULL,
  display_name TEXT NOT NULL, device_public_key TEXT NOT NULL, enrolled_at TEXT NOT NULL,
  last_synced_version INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_family ON devices(family_id);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, family_id TEXT NOT NULL, child_id TEXT NOT NULL,
  platform TEXT NOT NULL, expires_at TEXT NOT NULL, redeemed_at TEXT, created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enroll_code ON enrollment_tokens(code);

CREATE TABLE IF NOT EXISTS default_policy (
  family_id TEXT NOT NULL, child_id TEXT NOT NULL, web_default TEXT NOT NULL, youtube_default TEXT NOT NULL,
  PRIMARY KEY (family_id, child_id)
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL, target TEXT NOT NULL, value TEXT NOT NULL, action TEXT NOT NULL,
  scope_type TEXT NOT NULL, scope_child_id TEXT, scope_device_id TEXT, priority INTEGER,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_family ON rules(family_id);

CREATE TABLE IF NOT EXISTS temp_rules (
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL, target TEXT NOT NULL, value TEXT NOT NULL, action TEXT NOT NULL,
  scope_type TEXT NOT NULL, scope_child_id TEXT, scope_device_id TEXT, priority INTEGER,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  starts_at TEXT NOT NULL, expires_at TEXT NOT NULL, request_id TEXT NOT NULL, approved_by TEXT NOT NULL,
  grant_kind TEXT NOT NULL, consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_temp_family ON temp_rules(family_id);

CREATE TABLE IF NOT EXISTS policy_versions (
  family_id TEXT NOT NULL, child_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_id, child_id)
);

CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL, child_id TEXT NOT NULL, device_id TEXT NOT NULL,
  target_type TEXT NOT NULL, target_value TEXT NOT NULL, title TEXT, url TEXT, reason TEXT,
  status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_family ON access_requests(family_id);

CREATE TABLE IF NOT EXISTS approval_decisions (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, family_id TEXT NOT NULL, decided_by TEXT NOT NULL,
  decision TEXT NOT NULL, scope TEXT NOT NULL, duration TEXT NOT NULL, created_at TEXT NOT NULL,
  produced_rule_id TEXT
);

CREATE TABLE IF NOT EXISTS category_domains (
  category TEXT NOT NULL, domain TEXT NOT NULL, PRIMARY KEY (domain, category)
);
CREATE INDEX IF NOT EXISTS idx_catdom_domain ON category_domains(domain);
CREATE INDEX IF NOT EXISTS idx_catdom_category ON category_domains(category);
CREATE TABLE IF NOT EXISTS category_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS notification_endpoints (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, token TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_endpoints_user ON notification_endpoints(user_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL, actor_id TEXT, kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, seq INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_family ON audit_events(family_id);
`;

/**
 * Additive migrations for databases created by an earlier build. SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so each statement is run independently and a
 * "duplicate column name" error means the column is already there. Keep these
 * append-only and idempotent.
 */
export const MIGRATIONS_SQL: string[] = [
  "ALTER TABLE children ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'",
  "ALTER TABLE devices ADD COLUMN last_seen_at TEXT",
  "ALTER TABLE temp_rules ADD COLUMN consumed_at TEXT",
];

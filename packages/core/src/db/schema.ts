export const SCHEMA_VERSION = 4;

export const schemaSql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  password_params TEXT NOT NULL CHECK(json_valid(password_params)), version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_user_expiry ON sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, normalized_name TEXT NOT NULL, parent_scope_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(parent_scope_key, normalized_name)
) STRICT;
CREATE INDEX IF NOT EXISTS categories_parent ON categories(parent_id, id);
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS specifications (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('WAREHOUSE','BOX','BAG','ITEM')),
  parent_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
  stock_status TEXT CHECK(stock_status IN ('IN_STOCK','OUT','DISCARDED')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120), notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 2000),
  version INTEGER NOT NULL DEFAULT 1, location_version INTEGER NOT NULL DEFAULT 1,
  is_system_staging INTEGER NOT NULL DEFAULT 0 CHECK(is_system_staging IN (0,1)),
  last_in_stock_path TEXT CHECK(last_in_stock_path IS NULL OR json_valid(last_in_stock_path)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK((type = 'WAREHOUSE' AND parent_id IS NULL AND stock_status IS NULL) OR (type <> 'WAREHOUSE' AND stock_status IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_system_staging ON nodes(is_system_staging) WHERE is_system_staging=1;
CREATE INDEX IF NOT EXISTS nodes_parent_type ON nodes(parent_id, type, id);
CREATE INDEX IF NOT EXISTS nodes_status_type ON nodes(stock_status, type, id);
CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name, id);
CREATE TABLE IF NOT EXISTS item_profiles (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  specification TEXT NOT NULL DEFAULT '' CHECK(length(specification) <= 500)
) STRICT;
CREATE INDEX IF NOT EXISTS item_profiles_category ON item_profiles(category_id, node_id);
CREATE TABLE IF NOT EXISTS node_categories (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
  PRIMARY KEY(node_id, category_id)
) STRICT;
CREATE INDEX IF NOT EXISTS node_categories_category ON node_categories(category_id, node_id);
CREATE TABLE IF NOT EXISTS node_tags (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(node_id, tag_id)
) STRICT;
CREATE INDEX IF NOT EXISTS node_tags_tag ON node_tags(tag_id, node_id);
CREATE TABLE IF NOT EXISTS node_specifications (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  specification_id TEXT NOT NULL REFERENCES specifications(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
  PRIMARY KEY(node_id, specification_id)
) STRICT;
CREATE INDEX IF NOT EXISTS node_specifications_specification ON node_specifications(specification_id, node_id);

CREATE TABLE IF NOT EXISTS code_sequences (
  prefix TEXT PRIMARY KEY CHECK(prefix IN ('W','C','I')), next_value INTEGER NOT NULL CHECK(next_value > 0)
) STRICT;
CREATE TABLE IF NOT EXISTS code_reservations (
  code TEXT PRIMARY KEY, node_id TEXT NOT NULL UNIQUE, user_id TEXT, request_id TEXT, payload_hash TEXT,
  state TEXT NOT NULL CHECK(state IN ('RESERVED','ACTIVE','DELETED','ABANDONED','EXPIRED')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(user_id, request_id)
) STRICT;
CREATE TABLE IF NOT EXISTS node_tombstones (
  node_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
  deleted_at INTEGER NOT NULL, operation_id TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS storage_roots (
  id TEXT PRIMARY KEY, root_uuid TEXT NOT NULL, absolute_path TEXT NOT NULL,
  layout_version INTEGER NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
  last_verified_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(root_uuid, generation)
) STRICT;
CREATE TABLE IF NOT EXISTS storage_migrations (
  id TEXT PRIMARY KEY, from_root_id TEXT NOT NULL REFERENCES storage_roots(id) ON DELETE RESTRICT,
  to_root_id TEXT REFERENCES storage_roots(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('PREFLIGHT','COPYING','VERIFYING','CANCEL_REQUESTED','COMMITTED','CANCELLED','FAILED','OLD_COPY_CLEANED')),
  manifest TEXT NOT NULL CHECK(json_valid(manifest)), checkpoint TEXT NOT NULL CHECK(json_valid(checkpoint)),
  error_code TEXT, lease_token TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS storage_migrations_state ON storage_migrations(state, updated_at, id);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY, owner_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  root_id TEXT NOT NULL REFERENCES storage_roots(id) ON DELETE RESTRICT,
  main_key TEXT NOT NULL, thumb_key TEXT NOT NULL, mime TEXT NOT NULL,
  main_width INTEGER NOT NULL, main_height INTEGER NOT NULL, main_bytes INTEGER NOT NULL,
  thumb_width INTEGER NOT NULL, thumb_height INTEGER NOT NULL, thumb_bytes INTEGER NOT NULL,
  main_checksum TEXT NOT NULL, thumb_checksum TEXT NOT NULL, sort_order INTEGER NOT NULL,
  processing_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('ACTIVE','REVOKED')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(root_id, main_key), UNIQUE(root_id, thumb_key)
) STRICT;
CREATE INDEX IF NOT EXISTS images_owner_status ON images(owner_node_id, status, sort_order, id);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_upload_id TEXT NOT NULL, state TEXT NOT NULL,
  root_id TEXT NOT NULL REFERENCES storage_roots(id) ON DELETE RESTRICT,
  original_filename TEXT NOT NULL, declared_mime TEXT NOT NULL, byte_length INTEGER NOT NULL,
  manifest TEXT NOT NULL CHECK(json_valid(manifest)), target_node_id TEXT, reserved_code TEXT,
  bind_request_id TEXT, bind_payload_hash TEXT, lease_token TEXT, lease_until INTEGER,
  expires_at INTEGER NOT NULL, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(owner_user_id, client_upload_id)
) STRICT;
CREATE INDEX IF NOT EXISTS uploads_state_expiry ON uploads(state, expires_at, id);
CREATE TABLE IF NOT EXISTS cleanup_jobs (
  id TEXT PRIMARY KEY, root_uuid TEXT NOT NULL, root_generation INTEGER NOT NULL,
  paths_manifest TEXT NOT NULL CHECK(json_valid(paths_manifest)), kind TEXT NOT NULL,
  state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
  lease_token TEXT, lease_until INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cleanup_due ON cleanup_jobs(state, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS operation_logs (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL,
  client_kind TEXT NOT NULL, action TEXT NOT NULL, subject_type TEXT NOT NULL,
  subject_id TEXT, before_snapshot TEXT CHECK(before_snapshot IS NULL OR json_valid(before_snapshot)),
  after_snapshot TEXT CHECK(after_snapshot IS NULL OR json_valid(after_snapshot)), reason TEXT,
  reverses_operation_id TEXT, summary TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS operations_created ON operation_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS operations_action ON operation_logs(action, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS operation_targets (
  operation_id TEXT NOT NULL REFERENCES operation_logs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL, code_snapshot TEXT NOT NULL, directly_operated INTEGER NOT NULL,
  before_snapshot TEXT NOT NULL CHECK(json_valid(before_snapshot)), after_snapshot TEXT NOT NULL CHECK(json_valid(after_snapshot)),
  PRIMARY KEY(operation_id, node_id)
) STRICT;
CREATE INDEX IF NOT EXISTS operation_targets_node ON operation_targets(node_id, operation_id);
CREATE TABLE IF NOT EXISTS request_results (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL, method TEXT NOT NULL,
  route TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('SUCCEEDED','REJECTED')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at INTEGER NOT NULL,
  UNIQUE(user_id, request_id)
) STRICT;

CREATE TABLE IF NOT EXISTS print_executors (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, token_hash TEXT NOT NULL,
  state TEXT NOT NULL, last_seen_at INTEGER NOT NULL, capabilities TEXT NOT NULL CHECK(json_valid(capabilities)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS print_pairings (
  id TEXT PRIMARY KEY, created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, used_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS print_jobs (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, executor_id TEXT NOT NULL,
  printer_id TEXT NOT NULL, template_version INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT, related_job_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS print_jobs_executor ON print_jobs(executor_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS print_items (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES print_jobs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, node_id_snapshot TEXT NOT NULL, copy_index INTEGER NOT NULL,
  payload_snapshot TEXT NOT NULL CHECK(json_valid(payload_snapshot)), state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0, claim_token TEXT, claimed_at INTEGER,
  related_item_id TEXT, acknowledged_unknown INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(job_id, ordinal)
) STRICT;
CREATE INDEX IF NOT EXISTS print_items_job_state ON print_items(job_id, state, ordinal);
CREATE TABLE IF NOT EXISTS print_attempts (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES print_items(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL, state TEXT NOT NULL, claim_token TEXT NOT NULL,
  os_job_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT,
  UNIQUE(item_id, attempt_no)
) STRICT;

CREATE TABLE IF NOT EXISTS system_settings (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), staging_node_id TEXT NOT NULL,
  active_root_id TEXT NOT NULL REFERENCES storage_roots(id), maintenance_state TEXT NOT NULL,
  service_identity TEXT NOT NULL, schema_version INTEGER NOT NULL, data_revision INTEGER NOT NULL
) STRICT;
`;

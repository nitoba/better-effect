export const SQLITE_TABLES = {
  attempts: 'better_effect_mq_attempts',
  jobs: 'better_effect_mq_jobs',
  queues: 'better_effect_mq_queues',
  schemaVersions: 'better_effect_mq_schema_versions',
  schedules: 'better_effect_mq_schedules',
  outbox: 'better_effect_mq_outbox',
  state: 'better_effect_mq_sqlite_state',
  flowChildren: 'better_effect_mq_flow_children',
  flowOutbox: 'better_effect_mq_flow_outbox'
} as const

export const MIGRATION_COMPONENT = 'better-effect-mq-sqlite' as const
export const migrationSql = `
CREATE TABLE IF NOT EXISTS better_effect_mq_schema_versions (
  component TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, applied_at_ms INTEGER NOT NULL, checksum TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS better_effect_mq_jobs (
  row_sequence INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, id TEXT NOT NULL, queue TEXT NOT NULL, name TEXT NOT NULL,
  version INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), metadata TEXT NOT NULL CHECK (json_valid(metadata)), record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  priority INTEGER NOT NULL, run_at_ms INTEGER NOT NULL, order_sequence INTEGER NOT NULL, attempts_max INTEGER NOT NULL,
  attempts_made INTEGER NOT NULL, attempt_sequence INTEGER NOT NULL, delivery_count INTEGER NOT NULL, stalled_count INTEGER NOT NULL,
  backoff TEXT, timeout_ms INTEGER, idempotency_key TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER, finished_at_ms INTEGER, lease_owner TEXT, lease_token TEXT, lease_expires_at_ms INTEGER,
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)), cancellation_requested_at_ms INTEGER,
  result TEXT, failure TEXT, last_settlement_token TEXT, last_settlement_digest TEXT, last_settlement_outcome TEXT,
  UNIQUE(namespace, id),
  CHECK (state IN ('waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled')),
  CHECK (version > 0 AND attempts_max >= 1 AND attempts_made >= 0 AND attempts_made <= attempts_max),
  CHECK (state != 'active' OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS better_effect_mq_attempts (
  ledger_sequence INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, job_id TEXT NOT NULL, attempt_sequence INTEGER NOT NULL,
  attempt INTEGER NOT NULL, delivery INTEGER NOT NULL, started_at_ms INTEGER, finished_at_ms INTEGER NOT NULL, outcome TEXT NOT NULL,
  result TEXT, failure TEXT, worker_id TEXT, retry_at_ms INTEGER, retry_delay_ms INTEGER, attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  FOREIGN KEY(namespace, job_id) REFERENCES better_effect_mq_jobs(namespace, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS better_effect_mq_queues (
  namespace TEXT NOT NULL, queue TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  wake_version INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(namespace, queue)
);
CREATE TABLE IF NOT EXISTS better_effect_mq_sqlite_state (
  namespace TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL CHECK (json_valid(state_json)), updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_claim_idx ON better_effect_mq_jobs(namespace, queue, state, priority DESC, run_at_ms, order_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_active_lease_idx ON better_effect_mq_jobs(namespace, state, lease_expires_at_ms);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_identity_idx ON better_effect_mq_jobs(namespace, queue, name, version, state);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_created_idx ON better_effect_mq_jobs(namespace, created_at_ms, order_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_run_at_idx ON better_effect_mq_jobs(namespace, run_at_ms, order_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_finished_idx ON better_effect_mq_jobs(namespace, finished_at_ms, order_sequence, id);
CREATE UNIQUE INDEX IF NOT EXISTS better_effect_mq_jobs_idempotency_idx ON better_effect_mq_jobs(namespace, queue, name, version, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS better_effect_mq_attempts_job_idx ON better_effect_mq_attempts(namespace, job_id, ledger_sequence);
`

/** Schedule extension migration. Keep this separate so version-one checksums remain stable. */
export const scheduleMigrationSql = `
CREATE TABLE IF NOT EXISTS better_effect_mq_schedules (
  namespace TEXT NOT NULL,
  schedule_key TEXT NOT NULL,
  schedule_group TEXT NOT NULL,
  job_queue TEXT NOT NULL,
  job_name TEXT NOT NULL,
  job_version INTEGER NOT NULL,
  queue TEXT NOT NULL,
  cron TEXT,
  every_ms INTEGER,
  time_zone TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) IS NOT NULL),
  metadata TEXT NOT NULL CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  priority INTEGER NOT NULL,
  attempts_max INTEGER NOT NULL,
  backoff TEXT,
  timeout_ms INTEGER,
  misfire TEXT NOT NULL CHECK (json_valid(misfire) AND json_type(misfire) = 'object'),
  overlap TEXT NOT NULL,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  revision INTEGER NOT NULL,
  next_run_at_ms INTEGER NOT NULL,
  last_scheduled_at_ms INTEGER,
  last_job_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (namespace, schedule_group, schedule_key),
  CHECK (namespace <> '' AND schedule_key <> '' AND schedule_group <> '' AND job_queue <> '' AND job_name <> '' AND queue <> ''),
  CHECK ((cron IS NOT NULL AND every_ms IS NULL) OR (cron IS NULL AND every_ms IS NOT NULL)),
  CHECK (job_version > 0 AND (every_ms IS NULL OR every_ms > 0) AND priority BETWEEN -9007199254740991 AND 9007199254740991 AND attempts_max >= 1 AND revision BETWEEN 0 AND 9007199254740991),
  CHECK (next_run_at_ms BETWEEN 0 AND 9007199254740991 AND created_at_ms BETWEEN 0 AND 9007199254740991 AND updated_at_ms BETWEEN 0 AND 9007199254740991 AND (timeout_ms IS NULL OR timeout_ms BETWEEN 1 AND 9007199254740991) AND (last_scheduled_at_ms IS NULL OR last_scheduled_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK (overlap IN ('allow', 'skip'))
);
CREATE INDEX IF NOT EXISTS better_effect_mq_schedules_due_idx ON better_effect_mq_schedules(namespace, paused, next_run_at_ms, schedule_group, schedule_key);
CREATE INDEX IF NOT EXISTS better_effect_mq_schedules_group_idx ON better_effect_mq_schedules(namespace, schedule_group, schedule_key);
CREATE INDEX IF NOT EXISTS better_effect_mq_schedules_key_idx ON better_effect_mq_schedules(namespace, schedule_key, schedule_group);
`

/** Durable outbox extension migration. Keep migrations 1 and 2 checksummed independently. */
export const outboxMigrationSql = `
CREATE TABLE IF NOT EXISTS better_effect_mq_outbox (
  row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
  request_digest TEXT NOT NULL,
  attempts_max INTEGER NOT NULL,
  attempts_made INTEGER NOT NULL,
  run_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  published_at_ms INTEGER,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  failure TEXT CHECK (failure IS NULL OR (json_valid(failure) AND json_type(failure) = 'object')),
  ordering_sequence INTEGER NOT NULL,
  UNIQUE(namespace, id),
  CHECK (namespace <> '' AND id <> '' AND target <> ''),
  CHECK (state IN ('pending', 'active', 'published', 'failed')),
  CHECK (protocol_version = 1 AND request_digest <> ''),
  CHECK (attempts_max >= 1 AND attempts_made >= 0 AND attempts_made <= attempts_max),
  CHECK (run_at_ms BETWEEN 0 AND 9007199254740991 AND created_at_ms BETWEEN 0 AND 9007199254740991 AND updated_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (published_at_ms IS NULL OR published_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (ordering_sequence BETWEEN 1 AND 9007199254740991),
  CHECK (state != 'active' OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)),
  CHECK (state = 'active' OR (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at_ms IS NULL)),
  CHECK (state != 'published' OR published_at_ms IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS better_effect_mq_outbox_claim_idx ON better_effect_mq_outbox(namespace, state, run_at_ms, created_at_ms, ordering_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_outbox_active_lease_idx ON better_effect_mq_outbox(namespace, state, lease_expires_at_ms, ordering_sequence);
CREATE INDEX IF NOT EXISTS better_effect_mq_outbox_target_state_idx ON better_effect_mq_outbox(namespace, target, state, run_at_ms, ordering_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_outbox_recent_idx ON better_effect_mq_outbox(namespace, created_at_ms, ordering_sequence, id);
`

/** Flow protocol v2 migration. Historical v1-v3 SQL remains unchanged. */
export const flowMigrationSql = `
CREATE TABLE better_effect_mq_jobs_flow_v2 (
  row_sequence INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, id TEXT NOT NULL, queue TEXT NOT NULL, name TEXT NOT NULL,
  version INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), metadata TEXT NOT NULL CHECK (json_valid(metadata)), record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  priority INTEGER NOT NULL, run_at_ms INTEGER NOT NULL, order_sequence INTEGER NOT NULL, attempts_max INTEGER NOT NULL,
  attempts_made INTEGER NOT NULL, attempt_sequence INTEGER NOT NULL, delivery_count INTEGER NOT NULL, stalled_count INTEGER NOT NULL,
  backoff TEXT, timeout_ms INTEGER, idempotency_key TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER, finished_at_ms INTEGER, lease_owner TEXT, lease_token TEXT, lease_expires_at_ms INTEGER,
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)), cancellation_requested_at_ms INTEGER,
  result TEXT, failure TEXT, last_settlement_token TEXT, last_settlement_digest TEXT, last_settlement_outcome TEXT,
  parent TEXT CHECK (parent IS NULL OR json_valid(parent)), flow TEXT CHECK (flow IS NULL OR json_valid(flow)),
  flow_manifest_digest TEXT, flow_lease_token TEXT, flow_name TEXT, flow_parent_store_key TEXT, flow_depth INTEGER,
  UNIQUE(namespace, id),
  CHECK (state IN ('waiting', 'delayed', 'active', 'waiting-children', 'completed', 'failed', 'cancelled')),
  CHECK (version > 0 AND attempts_max >= 1 AND attempts_made >= 0 AND attempts_made <= attempts_max),
  CHECK (state != 'active' OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)),
  CHECK (flow_manifest_digest IS NULL OR flow_manifest_digest <> ''),
  CHECK (flow_lease_token IS NULL OR flow_lease_token <> ''),
  CHECK (flow_name IS NULL OR flow_name <> ''),
  CHECK (flow_parent_store_key IS NULL OR flow_parent_store_key <> ''),
  CHECK (flow_depth IS NULL OR flow_depth BETWEEN 1 AND 32)
);
INSERT INTO better_effect_mq_jobs_flow_v2 (
  row_sequence, namespace, id, queue, name, version, state, payload, metadata, record_json,
  priority, run_at_ms, order_sequence, attempts_max, attempts_made, attempt_sequence,
  delivery_count, stalled_count, backoff, timeout_ms, idempotency_key, created_at_ms, updated_at_ms,
  processed_at_ms, finished_at_ms, lease_owner, lease_token, lease_expires_at_ms, cancel_requested,
  cancellation_requested_at_ms, result, failure, last_settlement_token, last_settlement_digest,
  last_settlement_outcome
)
SELECT row_sequence, namespace, id, queue, name, version, state, payload, metadata, record_json,
  priority, run_at_ms, order_sequence, attempts_max, attempts_made, attempt_sequence,
  delivery_count, stalled_count, backoff, timeout_ms, idempotency_key, created_at_ms, updated_at_ms,
  processed_at_ms, finished_at_ms, lease_owner, lease_token, lease_expires_at_ms, cancel_requested,
  cancellation_requested_at_ms, result, failure, last_settlement_token, last_settlement_digest,
  last_settlement_outcome
FROM better_effect_mq_jobs;
DROP TABLE better_effect_mq_jobs;
ALTER TABLE better_effect_mq_jobs_flow_v2 RENAME TO better_effect_mq_jobs;
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_claim_idx ON better_effect_mq_jobs(namespace, queue, state, priority DESC, run_at_ms, order_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_active_lease_idx ON better_effect_mq_jobs(namespace, state, lease_expires_at_ms);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_identity_idx ON better_effect_mq_jobs(namespace, queue, name, version, state);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_created_idx ON better_effect_mq_jobs(namespace, created_at_ms, order_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_run_at_idx ON better_effect_mq_jobs(namespace, run_at_ms, order_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_finished_idx ON better_effect_mq_jobs(namespace, finished_at_ms, order_sequence, id);
CREATE UNIQUE INDEX IF NOT EXISTS better_effect_mq_jobs_idempotency_idx ON better_effect_mq_jobs(namespace, queue, name, version, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_waiting_children_idx ON better_effect_mq_jobs(namespace, state, updated_at_ms, order_sequence, id) WHERE state = 'waiting-children';

CREATE TABLE IF NOT EXISTS better_effect_mq_flow_children (
  row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  child_key TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  store_key TEXT NOT NULL,
  child_job_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
  status TEXT NOT NULL,
  result TEXT,
  failure TEXT,
  cascaded INTEGER NOT NULL DEFAULT 0 CHECK (cascaded IN (0, 1)),
  pending_since_ms INTEGER NOT NULL,
  FOREIGN KEY(namespace, flow_id) REFERENCES better_effect_mq_jobs(namespace, id) ON DELETE CASCADE,
  UNIQUE(namespace, flow_id, child_key),
  UNIQUE(namespace, child_job_id),
  CHECK (namespace <> '' AND flow_id <> '' AND child_key <> '' AND name <> '' AND version > 0 AND store_key <> '' AND child_job_id <> ''),
  CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  CHECK (result IS NULL OR json_valid(result)),
  CHECK (failure IS NULL OR (json_valid(failure) AND json_type(failure) = 'object')),
  CHECK (pending_since_ms BETWEEN 0 AND 9007199254740991),
  CHECK (status != 'pending' OR (result IS NULL AND failure IS NULL)),
  CHECK (status != 'completed' OR failure IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS better_effect_mq_flow_children_job_idx ON better_effect_mq_flow_children(namespace, child_job_id);
CREATE INDEX IF NOT EXISTS better_effect_mq_flow_children_pending_idx ON better_effect_mq_flow_children(namespace, flow_id, pending_since_ms, child_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS better_effect_mq_flow_children_cascade_idx ON better_effect_mq_flow_children(namespace, flow_id, child_key) WHERE status = 'cancelled' AND cascaded = 0;

CREATE TABLE IF NOT EXISTS better_effect_mq_flow_outbox (
  row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  flow_name TEXT NOT NULL,
  parent_store_key TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK (json_valid(report_json) AND json_type(report_json) = 'object'),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(namespace, id),
  CHECK (namespace <> '' AND id <> '' AND flow_name <> '' AND parent_store_key <> '' AND created_at_ms BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX IF NOT EXISTS better_effect_mq_flow_outbox_claim_idx ON better_effect_mq_flow_outbox(namespace, row_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_flow_outbox_route_idx ON better_effect_mq_flow_outbox(namespace, parent_store_key, row_sequence, id);
`

export const SQLITE_INDEXES = [
  'better_effect_mq_jobs_claim_idx',
  'better_effect_mq_jobs_active_lease_idx',
  'better_effect_mq_jobs_identity_idx',
  'better_effect_mq_jobs_created_idx',
  'better_effect_mq_jobs_run_at_idx',
  'better_effect_mq_jobs_finished_idx',
  'better_effect_mq_jobs_idempotency_idx',
  'better_effect_mq_attempts_job_idx',
  'better_effect_mq_schedules_due_idx',
  'better_effect_mq_schedules_group_idx',
  'better_effect_mq_schedules_key_idx',
  'better_effect_mq_jobs_waiting_children_idx',
  'better_effect_mq_flow_children_job_idx',
  'better_effect_mq_flow_children_pending_idx',
  'better_effect_mq_flow_children_cascade_idx',
  'better_effect_mq_flow_outbox_claim_idx',
  'better_effect_mq_flow_outbox_route_idx',
  'better_effect_mq_outbox_claim_idx',
  'better_effect_mq_outbox_active_lease_idx',
  'better_effect_mq_outbox_target_state_idx',
  'better_effect_mq_outbox_recent_idx'
] as const

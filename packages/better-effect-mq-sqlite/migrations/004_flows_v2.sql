-- better-effect-mq FlowStore protocol v2 extension, migration 4.
-- The migrator applies this script inside BEGIN IMMEDIATE and temporarily disables
-- foreign-key enforcement while rebuilding the jobs table.

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

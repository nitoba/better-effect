CREATE TABLE IF NOT EXISTS better_effect_mq_schema_versions (
  component TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, applied_at_ms INTEGER NOT NULL, checksum TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS better_effect_mq_jobs (
  row_sequence INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, id TEXT NOT NULL, queue TEXT NOT NULL, name TEXT NOT NULL,
  version INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)), metadata TEXT NOT NULL CHECK (json_valid(metadata)),
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
  result TEXT, failure TEXT, worker_id TEXT, retry_at_ms INTEGER, retry_delay_ms INTEGER,
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

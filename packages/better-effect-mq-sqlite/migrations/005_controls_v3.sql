-- better-effect-mq QueueControls protocol v3 extension, migration 5.
-- The migrator applies this script inside BEGIN IMMEDIATE.

ALTER TABLE better_effect_mq_jobs ADD COLUMN dispatch_key TEXT;
UPDATE better_effect_mq_jobs
SET dispatch_key = json_extract(record_json, '$.dispatchKey')
WHERE dispatch_key IS NULL AND json_type(record_json, '$.dispatchKey') = 'text';

CREATE TABLE IF NOT EXISTS better_effect_mq_queue_controls (
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  control_group TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL,
  global_concurrency INTEGER,
  per_key_concurrency INTEGER,
  rate_limit_max INTEGER,
  rate_limit_duration_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(namespace, queue),
  CHECK (namespace <> '' AND queue <> '' AND control_group <> '' AND revision > 0),
  CHECK (global_concurrency IS NULL OR global_concurrency > 0),
  CHECK (per_key_concurrency IS NULL OR per_key_concurrency > 0),
  CHECK ((rate_limit_max IS NULL AND rate_limit_duration_ms IS NULL) OR
    (rate_limit_max > 0 AND rate_limit_duration_ms > 0)),
  CHECK (created_at_ms BETWEEN 0 AND 9007199254740991 AND updated_at_ms BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE IF NOT EXISTS better_effect_mq_queue_control_cursors (
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  cursor_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(namespace, queue),
  FOREIGN KEY(namespace, queue) REFERENCES better_effect_mq_queue_controls(namespace, queue) ON DELETE CASCADE,
  CHECK (namespace <> '' AND queue <> '' AND cursor_sequence >= 0),
  CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE IF NOT EXISTS better_effect_mq_controlled_permits (
  namespace TEXT NOT NULL,
  job_id TEXT NOT NULL,
  queue TEXT NOT NULL,
  dispatch_key TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  PRIMARY KEY(namespace, job_id),
  FOREIGN KEY(namespace, job_id) REFERENCES better_effect_mq_jobs(namespace, id) ON DELETE CASCADE,
  CHECK (namespace <> '' AND job_id <> '' AND queue <> '' AND dispatch_key <> '' AND lease_token <> ''),
  CHECK (length(dispatch_key) <= 512 AND acquired_at_ms BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE IF NOT EXISTS better_effect_mq_rate_windows (
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  claim_count INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(namespace, queue),
  CHECK (namespace <> '' AND queue <> '' AND started_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (claim_count >= 0 AND updated_at_ms BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_dispatch_idx
  ON better_effect_mq_jobs(namespace, queue, dispatch_key, state, priority DESC, run_at_ms, order_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_controlled_permits_queue_key_idx
  ON better_effect_mq_controlled_permits(namespace, queue, dispatch_key, job_id);
CREATE INDEX IF NOT EXISTS better_effect_mq_controlled_permits_job_token_idx
  ON better_effect_mq_controlled_permits(namespace, job_id, lease_token);
CREATE INDEX IF NOT EXISTS better_effect_mq_rate_windows_expiry_idx
  ON better_effect_mq_rate_windows(namespace, queue, started_at_ms);

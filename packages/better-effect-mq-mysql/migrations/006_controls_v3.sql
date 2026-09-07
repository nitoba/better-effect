-- MySQL / InnoDB controlled-claim protocol v3.
-- Every mutable control is durable and namespaced; all claim-side records are
-- locked by the adapter in control -> rate window -> cursor/permits -> jobs order.

ALTER TABLE better_effect_mq_jobs
  ADD COLUMN dispatch_key VARCHAR(512) NULL AFTER queue;

ALTER TABLE better_effect_mq_jobs
  ADD CONSTRAINT better_effect_mq_jobs_dispatch_key_values
  CHECK (dispatch_key IS NULL OR (dispatch_key <> '' AND dispatch_key <> '__none__'));

CREATE INDEX better_effect_mq_jobs_dispatch_idx
  -- namespace, queue, and dispatch_key retain the bounded lookup prefixes.
  -- The unique sequence precedes id in the claim order, so a shorter id
  -- tie-breaker keeps this utf8mb4 index below InnoDB's 3072-byte limit.
  ON better_effect_mq_jobs (namespace(191), queue(191), dispatch_key(191), state, priority DESC, run_at_ms, sequence, id(128));

CREATE TABLE IF NOT EXISTS better_effect_mq_queue_controls (
  namespace VARCHAR(255) NOT NULL,
  queue VARCHAR(255) NOT NULL,
  control_group VARCHAR(255) NOT NULL,
  enabled BOOLEAN NOT NULL,
  revision BIGINT NOT NULL,
  global_concurrency BIGINT NULL,
  per_key_concurrency BIGINT NULL,
  rate_limit_max BIGINT NULL,
  rate_limit_duration_ms BIGINT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (namespace, queue),
  CONSTRAINT better_effect_mq_queue_controls_values CHECK (
    namespace <> '' AND queue <> '' AND control_group <> ''
    AND revision > 0
    AND (global_concurrency IS NULL OR global_concurrency > 0)
    AND (per_key_concurrency IS NULL OR per_key_concurrency > 0)
    AND ((rate_limit_max IS NULL AND rate_limit_duration_ms IS NULL)
      OR (rate_limit_max > 0 AND rate_limit_duration_ms > 0))
    AND created_at_ms BETWEEN 0 AND 9007199254740991
    AND updated_at_ms BETWEEN 0 AND 9007199254740991
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS better_effect_mq_queue_control_cursors (
  namespace VARCHAR(255) NOT NULL,
  queue VARCHAR(255) NOT NULL,
  cursor_sequence BIGINT NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (namespace, queue),
  CONSTRAINT better_effect_mq_queue_control_cursors_values CHECK (
    namespace <> '' AND queue <> '' AND cursor_sequence >= 0
    AND updated_at_ms BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT better_effect_mq_queue_control_cursors_queue_fk
    FOREIGN KEY (namespace, queue)
    REFERENCES better_effect_mq_queue_controls(namespace, queue) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS better_effect_mq_controlled_permits (
  namespace VARCHAR(255) NOT NULL,
  job_id VARCHAR(255) NOT NULL,
  queue VARCHAR(255) NOT NULL,
  dispatch_key VARCHAR(512) NOT NULL,
  lease_token VARCHAR(255) NOT NULL,
  acquired_at_ms BIGINT NOT NULL,
  PRIMARY KEY (namespace, job_id),
  CONSTRAINT better_effect_mq_controlled_permits_values CHECK (
    namespace <> '' AND job_id <> '' AND queue <> '' AND dispatch_key <> ''
    AND lease_token <> ''
    AND acquired_at_ms BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT better_effect_mq_controlled_permits_job_fk
    FOREIGN KEY (namespace, job_id)
    REFERENCES better_effect_mq_jobs(namespace, id) ON DELETE CASCADE,
  KEY better_effect_mq_controlled_permits_queue_key_idx
    (namespace(191), queue(191), dispatch_key(191), job_id(191)),
  KEY better_effect_mq_controlled_permits_job_token_idx
    (namespace(191), job_id(191), lease_token(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS better_effect_mq_rate_windows (
  namespace VARCHAR(255) NOT NULL,
  queue VARCHAR(255) NOT NULL,
  started_at_ms BIGINT NOT NULL,
  claim_count BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (namespace, queue),
  CONSTRAINT better_effect_mq_rate_windows_values CHECK (
    namespace <> '' AND queue <> ''
    AND started_at_ms BETWEEN 0 AND 9007199254740991
    AND claim_count >= 0
    AND updated_at_ms BETWEEN 0 AND 9007199254740991
  ),
  KEY better_effect_mq_rate_windows_expiry_idx (namespace(191), queue(191), started_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- MySQL 8.0 / InnoDB protocol-v1 layout. All protocol time values are epoch milliseconds.
CREATE TABLE IF NOT EXISTS better_effect_mq_jobs (
  namespace VARCHAR(255) NOT NULL, id VARCHAR(255) NOT NULL, queue VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL, version BIGINT NOT NULL, state VARCHAR(16) NOT NULL,
  payload JSON NOT NULL, metadata JSON NOT NULL, priority BIGINT NOT NULL, run_at_ms BIGINT NOT NULL,
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, attempts_max BIGINT NOT NULL,
  attempts_made BIGINT NOT NULL DEFAULT 0, delivery_count BIGINT NOT NULL DEFAULT 0,
  stalled_count BIGINT NOT NULL DEFAULT 0, attempt_sequence BIGINT NOT NULL DEFAULT 0,
  backoff JSON NULL, timeout_ms BIGINT NULL, idempotency_key VARCHAR(255) NULL,
  dedupe_key VARCHAR(255) NULL, created_at_ms BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL,
  dedupe_hash BINARY(32) GENERATED ALWAYS AS (CASE WHEN dedupe_key IS NULL THEN NULL ELSE UNHEX(SHA2(CONCAT(namespace, CHAR(0), queue, CHAR(0), name, CHAR(0), version, CHAR(0), dedupe_key), 256)) END) STORED,
  processed_at_ms BIGINT NULL, finished_at_ms BIGINT NULL, lease_owner VARCHAR(255) NULL,
  lease_token VARCHAR(255) NULL, lease_expires_at_ms BIGINT NULL,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE, cancellation_requested_at_ms BIGINT NULL,
  result JSON NULL, failure JSON NULL, last_settlement_token VARCHAR(255) NULL,
  last_settlement_outcome LONGTEXT NULL, last_settlement_attempt_sequence BIGINT NULL,
  PRIMARY KEY (namespace, id), UNIQUE KEY better_effect_mq_jobs_sequence_unique (sequence),
  UNIQUE KEY better_effect_mq_jobs_idempotency_idx (namespace, dedupe_hash),
  CONSTRAINT better_effect_mq_jobs_state CHECK (state IN ('waiting','delayed','active','completed','failed','cancelled')),
  CONSTRAINT better_effect_mq_jobs_counters CHECK (attempts_max >= 1 AND attempts_made >= 0 AND attempts_made <= attempts_max AND attempts_made <= delivery_count AND delivery_count >= 0 AND stalled_count >= 0 AND attempt_sequence >= attempts_made),
  CONSTRAINT better_effect_mq_jobs_active_lease CHECK ((state = 'active' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL) OR (state <> 'active' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at_ms IS NULL)),
  CONSTRAINT better_effect_mq_jobs_times CHECK (run_at_ms BETWEEN 0 AND 9007199254740991 AND created_at_ms BETWEEN 0 AND 9007199254740991 AND updated_at_ms BETWEEN 0 AND 9007199254740991),
  KEY better_effect_mq_jobs_claim_idx (namespace(191), queue(191), state, priority DESC, run_at_ms ASC, sequence ASC, id(191) ASC),
  KEY better_effect_mq_jobs_active_lease_idx (namespace, state, lease_expires_at_ms),
  KEY better_effect_mq_jobs_identity_idx (namespace(191), queue(191), name(191), version, state),
  KEY better_effect_mq_jobs_recent_idx (namespace(191), created_at_ms DESC, sequence DESC, id(191) DESC),
  KEY better_effect_mq_jobs_run_at_idx (namespace(191), queue(191), state, run_at_ms, sequence, id(191)),
  KEY better_effect_mq_jobs_terminal_idx (namespace(191), state, finished_at_ms DESC, sequence DESC, id(191) DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS better_effect_mq_attempts (
  namespace VARCHAR(255) NOT NULL, job_id VARCHAR(255) NOT NULL,
  ledger_sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, attempt_sequence BIGINT NULL,
  attempt BIGINT NOT NULL, delivery BIGINT NOT NULL, started_at_ms BIGINT NULL,
  finished_at_ms BIGINT NOT NULL, outcome VARCHAR(16) NOT NULL, result JSON NULL,
  failure JSON NULL, worker_id VARCHAR(255) NULL, retry_at_ms BIGINT NULL, retry_delay_ms BIGINT NULL,
  PRIMARY KEY (namespace, job_id, ledger_sequence),
  CONSTRAINT better_effect_mq_attempts_job_fk FOREIGN KEY (namespace, job_id) REFERENCES better_effect_mq_jobs(namespace, id) ON DELETE CASCADE,
  CONSTRAINT better_effect_mq_attempts_outcome CHECK (outcome IN ('completed','retried','failed','cancelled','stalled','released')),
  CONSTRAINT better_effect_mq_attempts_values CHECK (attempt >= 1 AND delivery >= 1),
  KEY better_effect_mq_attempts_sequence_idx (ledger_sequence),
  KEY better_effect_mq_attempts_order_idx (namespace, job_id, ledger_sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS better_effect_mq_queues (
  namespace VARCHAR(255) NOT NULL, queue VARCHAR(255) NOT NULL, paused BOOLEAN NOT NULL DEFAULT FALSE,
  wake_version BIGINT NOT NULL DEFAULT 0, updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (namespace, queue), CONSTRAINT better_effect_mq_queues_values CHECK (wake_version BETWEEN 0 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Requeues need a fresh total-order value without deleting the job (which would
-- discard its attempt ledger). This allocator is deliberately independent of
-- the jobs identity key; gaps are harmless and expected after rollback.
CREATE TABLE IF NOT EXISTS better_effect_mq_ordering_sequences (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY
) ENGINE=InnoDB;

-- better-effect-mq durable JobEventStore extension, migration 7.
-- Cursors are allocated under the same InnoDB transaction as each JobStore transition.

CREATE TABLE IF NOT EXISTS better_effect_mq_job_event_cursors (
  namespace VARCHAR(255) NOT NULL,
  next_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace),
  CONSTRAINT better_effect_mq_job_event_cursors_values CHECK (
    namespace <> '' AND next_cursor <= 9007199254740991
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS better_effect_mq_job_events (
  namespace VARCHAR(255) NOT NULL,
  cursor BIGINT UNSIGNED NOT NULL,
  recorded_at_ms BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  job_id VARCHAR(255) NULL,
  queue VARCHAR(255) NULL,
  name VARCHAR(255) NULL,
  version BIGINT UNSIGNED NULL,
  state VARCHAR(32) NULL,
  attempt BIGINT UNSIGNED NULL,
  delivery BIGINT UNSIGNED NULL,
  worker_id VARCHAR(255) NULL,
  outcome VARCHAR(32) NULL,
  failure_kind VARCHAR(64) NULL,
  duplicate BOOLEAN NULL,
  attributes JSON NOT NULL,
  PRIMARY KEY (namespace, cursor),
  CONSTRAINT better_effect_mq_job_events_values CHECK (
    namespace <> '' AND cursor > 0
    AND recorded_at_ms <= 9007199254740991
    AND (job_id IS NULL OR job_id <> '')
    AND (queue IS NULL OR queue <> '')
    AND (name IS NULL OR name <> '')
    AND (version IS NULL OR version > 0)
    AND (attempt IS NULL OR attempt > 0)
    AND (delivery IS NULL OR delivery > 0)
    AND (worker_id IS NULL OR worker_id <> '')
    AND JSON_TYPE(attributes) = 'OBJECT'
  ),
  CONSTRAINT better_effect_mq_job_events_type CHECK (
    event_type IN (
      'job-enqueued', 'job-claimed', 'job-completed', 'job-retry-scheduled',
      'job-failed', 'job-cancelled', 'job-cancel-requested', 'job-released',
      'job-stalled-recovered', 'job-promoted', 'job-admin-retried',
      'job-removed', 'queue-paused', 'queue-resumed'
    )
  ),
  KEY better_effect_mq_job_events_queue_cursor_idx (namespace(191), queue(191), cursor),
  KEY better_effect_mq_job_events_type_cursor_idx (namespace(191), event_type, cursor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- better-effect-mq durable JobEventStore extension, migration 6.
-- The adapter substitutes {{SCHEMA}} with one validated, quoted identifier.

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.better_effect_mq_job_event_cursors (
  namespace text PRIMARY KEY,
  next_cursor bigint NOT NULL DEFAULT 0,
  CONSTRAINT better_effect_mq_job_event_cursors_values CHECK (
    namespace <> '' AND next_cursor BETWEEN 0 AND 9007199254740991
  )
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.better_effect_mq_job_events (
  namespace text NOT NULL,
  cursor bigint NOT NULL,
  recorded_at_ms bigint NOT NULL,
  event_type text NOT NULL,
  job_id text,
  queue text,
  name text,
  version bigint,
  state text,
  attempt bigint,
  delivery bigint,
  worker_id text,
  outcome text,
  failure_kind text,
  duplicate boolean,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (namespace, cursor),
  CONSTRAINT better_effect_mq_job_events_values CHECK (
    namespace <> '' AND cursor > 0
    AND recorded_at_ms BETWEEN 0 AND 9007199254740991
    AND (job_id IS NULL OR job_id <> '')
    AND (queue IS NULL OR queue <> '')
    AND (name IS NULL OR name <> '')
    AND (version IS NULL OR version > 0)
    AND (attempt IS NULL OR attempt > 0)
    AND (delivery IS NULL OR delivery > 0)
    AND (worker_id IS NULL OR worker_id <> '')
    AND jsonb_typeof(attributes) = 'object'
    AND NOT jsonb_path_exists(attributes, '$.* ? (@.type() != "string")')
  ),
  CONSTRAINT better_effect_mq_job_events_type CHECK (
    event_type IN (
      'job-enqueued', 'job-claimed', 'job-completed', 'job-retry-scheduled',
      'job-failed', 'job-cancelled', 'job-cancel-requested', 'job-released',
      'job-stalled-recovered', 'job-promoted', 'job-admin-retried',
      'job-removed', 'queue-paused', 'queue-resumed'
    )
  )
);

CREATE INDEX IF NOT EXISTS better_effect_mq_job_events_queue_cursor_idx
  ON {{SCHEMA}}.better_effect_mq_job_events
  (namespace, queue COLLATE "C", cursor);
CREATE INDEX IF NOT EXISTS better_effect_mq_job_events_type_cursor_idx
  ON {{SCHEMA}}.better_effect_mq_job_events
  (namespace, event_type COLLATE "C", cursor);

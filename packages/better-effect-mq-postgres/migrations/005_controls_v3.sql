-- better-effect-mq PostgreSQL controlled-claim protocol v3.
-- Control rows and permits are namespaced so named JobStore instances remain isolated.

ALTER TABLE {{SCHEMA}}.better_effect_mq_jobs
  ADD COLUMN IF NOT EXISTS dispatch_key text;

ALTER TABLE {{SCHEMA}}.better_effect_mq_jobs
  DROP CONSTRAINT IF EXISTS better_effect_mq_jobs_dispatch_key_values;

ALTER TABLE {{SCHEMA}}.better_effect_mq_jobs
  ADD CONSTRAINT better_effect_mq_jobs_dispatch_key_values CHECK (
    dispatch_key IS NULL OR (dispatch_key <> '' AND length(dispatch_key) <= 512)
  );

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.better_effect_mq_queue_controls (
  namespace text NOT NULL,
  queue text NOT NULL,
  control_group text NOT NULL,
  enabled boolean NOT NULL,
  revision bigint NOT NULL,
  global_concurrency bigint,
  per_key_concurrency bigint,
  rate_limit_max bigint,
  rate_limit_duration_ms bigint,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
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
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.better_effect_mq_queue_control_cursors (
  namespace text NOT NULL,
  queue text NOT NULL,
  cursor_sequence bigint NOT NULL DEFAULT 0,
  updated_at_ms bigint NOT NULL,
  PRIMARY KEY (namespace, queue),
  CONSTRAINT better_effect_mq_queue_control_cursors_values CHECK (
    namespace <> '' AND queue <> '' AND cursor_sequence >= 0
    AND updated_at_ms BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT better_effect_mq_queue_control_cursors_queue_fk FOREIGN KEY (namespace, queue)
    REFERENCES {{SCHEMA}}.better_effect_mq_queue_controls(namespace, queue) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.better_effect_mq_controlled_permits (
  namespace text NOT NULL,
  job_id text NOT NULL,
  queue text NOT NULL,
  dispatch_key text NOT NULL,
  lease_token text NOT NULL,
  acquired_at_ms bigint NOT NULL,
  PRIMARY KEY (namespace, job_id),
  CONSTRAINT better_effect_mq_controlled_permits_values CHECK (
    namespace <> '' AND job_id <> '' AND queue <> '' AND dispatch_key <> ''
    AND lease_token <> '' AND length(dispatch_key) <= 512
    AND acquired_at_ms BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT better_effect_mq_controlled_permits_job_fk FOREIGN KEY (namespace, job_id)
    REFERENCES {{SCHEMA}}.better_effect_mq_jobs(namespace, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.better_effect_mq_rate_windows (
  namespace text NOT NULL,
  queue text NOT NULL,
  started_at_ms bigint NOT NULL,
  claim_count bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  PRIMARY KEY (namespace, queue),
  CONSTRAINT better_effect_mq_rate_windows_values CHECK (
    namespace <> '' AND queue <> '' AND started_at_ms BETWEEN 0 AND 9007199254740991
    AND claim_count >= 0 AND updated_at_ms BETWEEN 0 AND 9007199254740991
  )
);

CREATE INDEX IF NOT EXISTS better_effect_mq_jobs_dispatch_idx
  ON {{SCHEMA}}.better_effect_mq_jobs
  (namespace, queue, dispatch_key, state, priority DESC, run_at_ms, sequence, id COLLATE "C");

CREATE INDEX IF NOT EXISTS better_effect_mq_controlled_permits_queue_key_idx
  ON {{SCHEMA}}.better_effect_mq_controlled_permits
  (namespace, queue, dispatch_key, job_id COLLATE "C");

CREATE INDEX IF NOT EXISTS better_effect_mq_controlled_permits_job_token_idx
  ON {{SCHEMA}}.better_effect_mq_controlled_permits
  (namespace, job_id, lease_token);

CREATE INDEX IF NOT EXISTS better_effect_mq_rate_windows_expiry_idx
  ON {{SCHEMA}}.better_effect_mq_rate_windows (namespace, queue, started_at_ms);

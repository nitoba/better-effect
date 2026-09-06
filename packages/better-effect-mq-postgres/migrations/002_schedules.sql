-- better-effect-mq schedules extension, migration 2.
-- The adapter substitutes {{SCHEMA}} with one validated, quoted identifier.

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.better_effect_mq_schedules (
  namespace text NOT NULL,
  schedule_key text NOT NULL,
  schedule_group text NOT NULL,
  job_queue text NOT NULL,
  job_name text NOT NULL,
  job_version bigint NOT NULL,
  queue text NOT NULL,
  cron text,
  every_ms bigint,
  time_zone text,
  payload jsonb NOT NULL,
  metadata jsonb NOT NULL,
  priority bigint NOT NULL,
  attempts_max bigint NOT NULL,
  backoff jsonb,
  timeout_ms bigint,
  misfire jsonb NOT NULL,
  overlap text NOT NULL,
  paused boolean NOT NULL,
  revision bigint NOT NULL,
  next_run_at_ms bigint NOT NULL,
  last_scheduled_at_ms bigint,
  last_job_id text,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  PRIMARY KEY (namespace, schedule_group, schedule_key),
  CONSTRAINT better_effect_mq_schedules_nonempty CHECK (
    namespace <> '' AND schedule_key <> '' AND schedule_group <> ''
    AND job_queue <> '' AND job_name <> '' AND queue <> ''
  ),
  CONSTRAINT better_effect_mq_schedules_cadence CHECK (
    (cron IS NOT NULL AND every_ms IS NULL) OR (cron IS NULL AND every_ms IS NOT NULL)
  ),
  CONSTRAINT better_effect_mq_schedules_values CHECK (
    job_version > 0 AND (every_ms IS NULL OR every_ms > 0)
    AND priority BETWEEN -9007199254740991 AND 9007199254740991
    AND attempts_max >= 1 AND revision BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT better_effect_mq_schedules_epoch_ms CHECK (
    next_run_at_ms BETWEEN 0 AND 9007199254740991
    AND created_at_ms BETWEEN 0 AND 9007199254740991
    AND updated_at_ms BETWEEN 0 AND 9007199254740991
    AND (timeout_ms IS NULL OR timeout_ms BETWEEN 1 AND 9007199254740991)
    AND (last_scheduled_at_ms IS NULL OR last_scheduled_at_ms BETWEEN 0 AND 9007199254740991)
  ),
  CONSTRAINT better_effect_mq_schedules_metadata_values CHECK (
    jsonb_typeof(metadata) = 'object'
    AND NOT jsonb_path_exists(metadata, '$.* ? (@.type() != "string")')
  ),
  CONSTRAINT better_effect_mq_schedules_overlap CHECK (overlap IN ('allow', 'skip')),
  CONSTRAINT better_effect_mq_schedules_payload CHECK (jsonb_typeof(payload) IS NOT NULL),
  CONSTRAINT better_effect_mq_schedules_misfire CHECK (jsonb_typeof(misfire) = 'object')
);

CREATE INDEX IF NOT EXISTS better_effect_mq_schedules_due_idx
  ON {{SCHEMA}}.better_effect_mq_schedules
  (namespace, paused, next_run_at_ms ASC, schedule_group COLLATE "C" ASC, schedule_key COLLATE "C" ASC);
CREATE INDEX IF NOT EXISTS better_effect_mq_schedules_group_idx
  ON {{SCHEMA}}.better_effect_mq_schedules
  (namespace, schedule_group COLLATE "C" ASC, schedule_key COLLATE "C" ASC);
CREATE INDEX IF NOT EXISTS better_effect_mq_schedules_key_idx
  ON {{SCHEMA}}.better_effect_mq_schedules
  (namespace, schedule_key COLLATE "C" ASC, schedule_group COLLATE "C" ASC);

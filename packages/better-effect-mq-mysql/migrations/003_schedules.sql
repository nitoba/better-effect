-- better-effect-mq schedules extension, migration 3.
-- All protocol timestamps are caller/Clock supplied epoch milliseconds.
CREATE TABLE IF NOT EXISTS better_effect_mq_schedules (
  namespace VARCHAR(255) NOT NULL,
  schedule_key VARCHAR(255) NOT NULL,
  schedule_group VARCHAR(255) NOT NULL,
  job_queue VARCHAR(255) NOT NULL,
  job_name VARCHAR(255) NOT NULL,
  job_version BIGINT NOT NULL,
  queue VARCHAR(255) NOT NULL,
  cron VARCHAR(255) NULL,
  every_ms BIGINT NULL,
  time_zone VARCHAR(255) NULL,
  payload JSON NOT NULL,
  metadata JSON NOT NULL,
  priority BIGINT NOT NULL,
  attempts_max BIGINT NOT NULL,
  backoff JSON NULL,
  timeout_ms BIGINT NULL,
  misfire JSON NOT NULL,
  overlap VARCHAR(16) NOT NULL,
  paused BOOLEAN NOT NULL,
  revision BIGINT NOT NULL,
  next_run_at_ms BIGINT NOT NULL,
  last_scheduled_at_ms BIGINT NULL,
  last_job_id VARCHAR(255) NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
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
  CONSTRAINT better_effect_mq_schedules_overlap CHECK (overlap IN ('allow', 'skip'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX better_effect_mq_schedules_due_idx
  ON better_effect_mq_schedules
  (namespace(191), paused, next_run_at_ms ASC, schedule_group(191), schedule_key(191));
CREATE INDEX better_effect_mq_schedules_group_idx
  ON better_effect_mq_schedules
  (namespace(191), schedule_group(191), schedule_key(191));
CREATE INDEX better_effect_mq_schedules_key_idx
  ON better_effect_mq_schedules
  (namespace(191), schedule_key(191), schedule_group(191));

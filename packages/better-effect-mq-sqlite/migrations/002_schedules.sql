-- better-effect-mq schedules extension, migration 2.

CREATE TABLE IF NOT EXISTS better_effect_mq_schedules (
  namespace TEXT NOT NULL,
  schedule_key TEXT NOT NULL,
  schedule_group TEXT NOT NULL,
  job_queue TEXT NOT NULL,
  job_name TEXT NOT NULL,
  job_version INTEGER NOT NULL,
  queue TEXT NOT NULL,
  cron TEXT,
  every_ms INTEGER,
  time_zone TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) IS NOT NULL),
  metadata TEXT NOT NULL CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  priority INTEGER NOT NULL,
  attempts_max INTEGER NOT NULL,
  backoff TEXT,
  timeout_ms INTEGER,
  misfire TEXT NOT NULL CHECK (json_valid(misfire) AND json_type(misfire) = 'object'),
  overlap TEXT NOT NULL,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  revision INTEGER NOT NULL,
  next_run_at_ms INTEGER NOT NULL,
  last_scheduled_at_ms INTEGER,
  last_job_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (namespace, schedule_group, schedule_key),
  CHECK (namespace <> '' AND schedule_key <> '' AND schedule_group <> '' AND job_queue <> '' AND job_name <> '' AND queue <> ''),
  CHECK ((cron IS NOT NULL AND every_ms IS NULL) OR (cron IS NULL AND every_ms IS NOT NULL)),
  CHECK (job_version > 0 AND (every_ms IS NULL OR every_ms > 0) AND priority BETWEEN -9007199254740991 AND 9007199254740991 AND attempts_max >= 1 AND revision BETWEEN 0 AND 9007199254740991),
  CHECK (next_run_at_ms BETWEEN 0 AND 9007199254740991 AND created_at_ms BETWEEN 0 AND 9007199254740991 AND updated_at_ms BETWEEN 0 AND 9007199254740991 AND (timeout_ms IS NULL OR timeout_ms BETWEEN 1 AND 9007199254740991) AND (last_scheduled_at_ms IS NULL OR last_scheduled_at_ms BETWEEN 0 AND 9007199254740991)),
  CHECK (overlap IN ('allow', 'skip'))
);
CREATE INDEX IF NOT EXISTS better_effect_mq_schedules_due_idx ON better_effect_mq_schedules(namespace, paused, next_run_at_ms, schedule_group, schedule_key);
CREATE INDEX IF NOT EXISTS better_effect_mq_schedules_group_idx ON better_effect_mq_schedules(namespace, schedule_group, schedule_key);
CREATE INDEX IF NOT EXISTS better_effect_mq_schedules_key_idx ON better_effect_mq_schedules(namespace, schedule_key, schedule_group);

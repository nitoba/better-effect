-- better-effect-mq durable outbox extension, migration 3.

CREATE TABLE IF NOT EXISTS better_effect_mq_outbox (
  row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
  request_digest TEXT NOT NULL,
  attempts_max INTEGER NOT NULL,
  attempts_made INTEGER NOT NULL,
  run_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  published_at_ms INTEGER,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  failure TEXT CHECK (failure IS NULL OR (json_valid(failure) AND json_type(failure) = 'object')),
  ordering_sequence INTEGER NOT NULL,
  UNIQUE(namespace, id),
  CHECK (namespace <> '' AND id <> '' AND target <> ''),
  CHECK (state IN ('pending', 'active', 'published', 'failed')),
  CHECK (protocol_version = 1 AND request_digest <> ''),
  CHECK (attempts_max >= 1 AND attempts_made >= 0 AND attempts_made <= attempts_max),
  CHECK (run_at_ms BETWEEN 0 AND 9007199254740991 AND created_at_ms BETWEEN 0 AND 9007199254740991 AND updated_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (published_at_ms IS NULL OR published_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (ordering_sequence BETWEEN 1 AND 9007199254740991),
  CHECK (state != 'active' OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)),
  CHECK (state = 'active' OR (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at_ms IS NULL)),
  CHECK (state != 'published' OR published_at_ms IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS better_effect_mq_outbox_claim_idx ON better_effect_mq_outbox(namespace, state, run_at_ms, created_at_ms, ordering_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_outbox_active_lease_idx ON better_effect_mq_outbox(namespace, state, lease_expires_at_ms, ordering_sequence);
CREATE INDEX IF NOT EXISTS better_effect_mq_outbox_target_state_idx ON better_effect_mq_outbox(namespace, target, state, run_at_ms, ordering_sequence, id);
CREATE INDEX IF NOT EXISTS better_effect_mq_outbox_recent_idx ON better_effect_mq_outbox(namespace, created_at_ms, ordering_sequence, id);

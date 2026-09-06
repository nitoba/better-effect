-- Durable outbox layout. The request is already a validated PreparedEnqueue;
-- protocol time values are caller supplied epoch milliseconds.
CREATE TABLE IF NOT EXISTS better_effect_mq_outbox (
  namespace VARCHAR(255) NOT NULL,
  id VARCHAR(255) NOT NULL,
  protocol_version BIGINT NOT NULL,
  target VARCHAR(255) NOT NULL,
  state VARCHAR(16) NOT NULL,
  request JSON NOT NULL,
  metadata JSON NOT NULL,
  request_digest LONGTEXT NOT NULL,
  attempts_max BIGINT NOT NULL,
  attempts_made BIGINT NOT NULL DEFAULT 0,
  run_at_ms BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  published_at_ms BIGINT NULL,
  lease_owner VARCHAR(255) NULL,
  lease_token VARCHAR(255) NULL,
  lease_expires_at_ms BIGINT NULL,
  failure JSON NULL,
  ordering_sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (namespace, id),
  UNIQUE KEY better_effect_mq_outbox_ordering_unique (ordering_sequence),
  CONSTRAINT better_effect_mq_outbox_protocol CHECK (protocol_version = 1),
  CONSTRAINT better_effect_mq_outbox_state CHECK (state IN ('pending','active','published','failed')),
  CONSTRAINT better_effect_mq_outbox_counters CHECK (attempts_max >= 1 AND attempts_made >= 0 AND attempts_made <= attempts_max),
  CONSTRAINT better_effect_mq_outbox_lease CHECK ((state = 'active' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL) OR (state <> 'active' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at_ms IS NULL)),
  CONSTRAINT better_effect_mq_outbox_published CHECK ((state = 'published' AND published_at_ms IS NOT NULL) OR (state <> 'published')),
  CONSTRAINT better_effect_mq_outbox_times CHECK (run_at_ms BETWEEN 0 AND 9007199254740991 AND created_at_ms BETWEEN 0 AND 9007199254740991 AND updated_at_ms BETWEEN 0 AND 9007199254740991 AND (published_at_ms IS NULL OR published_at_ms BETWEEN 0 AND 9007199254740991) AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms BETWEEN 0 AND 9007199254740991))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE better_effect_mq_outbox
  ADD KEY better_effect_mq_outbox_claim_idx (namespace(191), state, run_at_ms, ordering_sequence, id(191));

ALTER TABLE better_effect_mq_outbox
  ADD KEY better_effect_mq_outbox_active_lease_idx (namespace(191), state, lease_expires_at_ms, ordering_sequence, id(191));

ALTER TABLE better_effect_mq_outbox
  ADD KEY better_effect_mq_outbox_target_idx (namespace(191), target(191), state, run_at_ms, ordering_sequence, id(191));

ALTER TABLE better_effect_mq_outbox
  ADD KEY better_effect_mq_outbox_recent_idx (namespace(191), created_at_ms, ordering_sequence, id(191));

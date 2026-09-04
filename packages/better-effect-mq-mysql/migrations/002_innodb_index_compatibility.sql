-- Forward-only MySQL 8 / InnoDB compatibility upgrade for the protocol-v1 layout.
-- Migration 001 is immutable: existing installations retain its checksum.
ALTER TABLE better_effect_mq_jobs
  ADD COLUMN dedupe_hash BINARY(32) GENERATED ALWAYS AS (CASE WHEN dedupe_key IS NULL THEN NULL ELSE UNHEX(SHA2(CONCAT(namespace, CHAR(0), queue, CHAR(0), name, CHAR(0), version, CHAR(0), dedupe_key), 256)) END) STORED;

ALTER TABLE better_effect_mq_jobs
  MODIFY COLUMN last_settlement_outcome LONGTEXT NULL;

ALTER TABLE better_effect_mq_jobs
  DROP INDEX better_effect_mq_jobs_idempotency_idx,
  ADD UNIQUE KEY better_effect_mq_jobs_idempotency_idx (namespace, dedupe_hash),
  DROP INDEX better_effect_mq_jobs_claim_idx,
  ADD KEY better_effect_mq_jobs_claim_idx (namespace(191), queue(191), state, priority DESC, run_at_ms ASC, sequence ASC, id(191) ASC),
  DROP INDEX better_effect_mq_jobs_identity_idx,
  ADD KEY better_effect_mq_jobs_identity_idx (namespace(191), queue(191), name(191), version, state),
  DROP INDEX better_effect_mq_jobs_recent_idx,
  ADD KEY better_effect_mq_jobs_recent_idx (namespace(191), created_at_ms DESC, sequence DESC, id(191) DESC),
  DROP INDEX better_effect_mq_jobs_run_at_idx,
  ADD KEY better_effect_mq_jobs_run_at_idx (namespace(191), queue(191), state, run_at_ms, sequence, id(191)),
  DROP INDEX better_effect_mq_jobs_terminal_idx,
  ADD KEY better_effect_mq_jobs_terminal_idx (namespace(191), state, finished_at_ms DESC, sequence DESC, id(191) DESC);

ALTER TABLE better_effect_mq_attempts
  ADD KEY better_effect_mq_attempts_sequence_idx (ledger_sequence);

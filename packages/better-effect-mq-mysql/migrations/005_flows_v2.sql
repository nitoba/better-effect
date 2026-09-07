-- better-effect-mq flow protocol v2 extension, migration 5.
-- This migration is additive and never rewrites migrations 001-004.
-- Flow rows use application-computed binary SHA-256 identities for indexes
-- because MySQL's InnoDB key limit is smaller than the protocol's UTF-8 field
-- limits. All mutations still match the complete textual identities.

ALTER TABLE better_effect_mq_jobs ADD COLUMN parent JSON NULL;
ALTER TABLE better_effect_mq_jobs ADD COLUMN flow JSON NULL;
ALTER TABLE better_effect_mq_jobs ADD COLUMN flow_manifest_digest LONGTEXT NULL;
ALTER TABLE better_effect_mq_jobs ADD COLUMN flow_lease_token VARCHAR(255) NULL;
ALTER TABLE better_effect_mq_jobs ADD COLUMN flow_name VARCHAR(128) NULL;
ALTER TABLE better_effect_mq_jobs ADD COLUMN flow_parent_store_key VARCHAR(512) NULL;
ALTER TABLE better_effect_mq_jobs ADD COLUMN flow_depth BIGINT NULL;
ALTER TABLE better_effect_mq_jobs DROP CHECK better_effect_mq_jobs_state;
ALTER TABLE better_effect_mq_jobs ADD CONSTRAINT better_effect_mq_jobs_state CHECK (state IN ('waiting','delayed','active','waiting-children','completed','failed','cancelled'));

CREATE TABLE IF NOT EXISTS better_effect_mq_flow_children (
  namespace VARCHAR(255) NOT NULL,
  flow_id VARCHAR(255) NOT NULL,
  child_key VARCHAR(512) NOT NULL,
  name VARCHAR(128) NOT NULL,
  version BIGINT NOT NULL,
  store_key VARCHAR(512) NOT NULL,
  child_job_id VARCHAR(1024) NOT NULL,
  request JSON NOT NULL,
  status VARCHAR(16) NOT NULL,
  result JSON NULL,
  failure JSON NULL,
  cascaded BOOLEAN NOT NULL DEFAULT FALSE,
  pending_since_ms BIGINT NOT NULL,
  flow_child_identity BINARY(32) NOT NULL,
  child_job_identity BINARY(32) NOT NULL,
  PRIMARY KEY (flow_child_identity),
  KEY better_effect_mq_flow_children_parent_idx (namespace, flow_id),
  UNIQUE KEY better_effect_mq_flow_children_job_unique (child_job_identity),
  CONSTRAINT better_effect_mq_flow_children_status CHECK (status IN ('pending','completed','failed','cancelled')),
  CONSTRAINT better_effect_mq_flow_children_values CHECK (version > 0 AND pending_since_ms BETWEEN 0 AND 9007199254740991),
  CONSTRAINT better_effect_mq_flow_children_json CHECK (JSON_TYPE(request) = 'OBJECT' AND (result IS NULL OR JSON_VALID(result)) AND (failure IS NULL OR JSON_TYPE(failure) = 'OBJECT')),
  CONSTRAINT better_effect_mq_flow_children_terminal CHECK ((status = 'pending' AND result IS NULL AND failure IS NULL) OR (status = 'completed' AND failure IS NULL) OR status IN ('failed','cancelled')),
  CONSTRAINT better_effect_mq_flow_children_parent_fk FOREIGN KEY (namespace, flow_id) REFERENCES better_effect_mq_jobs(namespace, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS better_effect_mq_flow_outbox (
  namespace VARCHAR(255) NOT NULL,
  id VARCHAR(1024) NOT NULL,
  id_identity BINARY(32) NOT NULL,
  flow_name VARCHAR(128) NOT NULL,
  parent_store_key VARCHAR(512) NOT NULL,
  report JSON NOT NULL,
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (namespace, sequence),
  UNIQUE KEY better_effect_mq_flow_outbox_sequence_unique (sequence),
  UNIQUE KEY better_effect_mq_flow_outbox_id_unique (namespace, id_identity),
  CONSTRAINT better_effect_mq_flow_outbox_values CHECK (JSON_TYPE(report) = 'OBJECT' AND created_at_ms BETWEEN 0 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX better_effect_mq_jobs_waiting_children_idx
  ON better_effect_mq_jobs (namespace(191), state, updated_at_ms, sequence, id(191));
CREATE INDEX better_effect_mq_flow_children_job_idx
  ON better_effect_mq_flow_children (namespace, child_job_identity);
CREATE INDEX better_effect_mq_flow_children_pending_idx
  ON better_effect_mq_flow_children (namespace(191), flow_id(191), status, pending_since_ms, child_key(191));
CREATE INDEX better_effect_mq_flow_children_cascade_idx
  ON better_effect_mq_flow_children (namespace(191), flow_id(191), status, cascaded, child_key(191));
CREATE INDEX better_effect_mq_flow_outbox_claim_idx
  ON better_effect_mq_flow_outbox (namespace(191), sequence);
CREATE INDEX better_effect_mq_flow_outbox_route_idx
  ON better_effect_mq_flow_outbox (namespace(191), parent_store_key(191), sequence);

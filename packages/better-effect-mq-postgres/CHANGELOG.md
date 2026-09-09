# Changelog

## Unreleased

- Add `PostgresOutbox.transaction` for adapter-owned domain writes and
  prepared outbox appends with automatic commit, rollback, and client cleanup.
- Add PostgreSQL controlled claim protocol v3 support with durable queue
  controls, dispatch keys, fixed-window rate limits, global/per-key permits,
  bounded fairness scanning, revision fencing, and atomic settlement/recovery.
- Add migration `005_controls_v3.sql` and schema validation for the controls
  tables and indexes.
- Add the PostgreSQL v1 `OutboxStore` adapter with transactional `appendIn`,
  digest-idempotent appends, fenced leases, settlements, recovery, inspection,
  and default/named Service Layers.
- Add migration `003_outbox.sql` and schema validation for the durable outbox
  layout.

## [0.1.1] - 2026-09-09

- Refresh the public README with current PostgreSQL adapter journeys,
  transaction, Flow, outbox, and QueueControls documentation.

## [0.1.0] - 2026-09-02

Initial release of `better-effect-mq-postgres`.

- Add the isolated `PostgresClient` boundary with explicit pool ownership.
- Add borrowed and config-backed client Layers.
- Add ordered, checksummed, locked, idempotent migrations.
- Add read-only schema validation and safe identifier/configuration checks.
- Ship the protocol schema, constraints, indexes, and migrations in the npm tarball.
- Keep PostgreSQL driver loading lazy through the optional `pg` peer.

This release includes the durable `JobStore` operations, claims, settlements,
heartbeats, and LISTEN/NOTIFY support provided by this adapter.

Future changes will be recorded here without promising a release date.

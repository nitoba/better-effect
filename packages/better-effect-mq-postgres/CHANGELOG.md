# Changelog

## [0.1.3] - 2026-09-10

- Add contextual `layerWith` and `layerFromConfigWith` factories for PostgreSQL
  stores. Their generators resolve configuration and caller-owned pools with
  `yield*` during Runtime acquisition, preserving one shared pool boundary.
- Add borrowed and config-backed Layers for `PostgresFlowStore`, including the
  same contextual factory variants.
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
- Updated the `better-effect` peer range to `>=0.14.0 <0.15.0` and aligned the
  MQ/outbox workspace peer artifacts with the current `0.1.x` releases.

## [0.1.2] - 2026-09-09

### Fixed

- Follow up the documentation release with a release-workflow fix that builds
  shared MQ workspace artifacts before consumer validation and runs this
  package's external consumer smoke test against the materialized builds.

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

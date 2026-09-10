# Changelog

## Unreleased

- Add `MySqlOutbox.transaction(pool, record, callback, options?)` for
  adapter-owned connection and transaction lifecycle around domain writes and
  automatic outbox appends; keep `appendIn` as the advanced caller-owned
  transaction escape hatch.
- Add the durable `JobEventStore` extension with migration 007, opaque
  namespace cursors, atomic transition appends, keyset reads, retention, and
  polling/local-wake event waits.
- Add QueueControls protocol v3 with additive migration 006, durable dispatch
  keys and revisioned controls, atomic InnoDB permits, fixed-window rate limits,
  bounded per-key fairness, stale-token fencing, and controlled lifecycle
  recovery.
- Add the MySQL Flow protocol v2 adapter, additive migration, deterministic
  child/dependency persistence, cross-store report outbox, reconciliation, and
  terminal child report integration with the JobStore.
- Add the MySQL durable outbox v1 table, typed transactional append, Layer-first
  default/named outbox stores, fenced leases, recovery, settlement, and admin
  inspection operations.
- Add the MySQL `JobScheduleStore` adapter and schedules migration.
- Add atomic, deterministic schedule ticks with durable queue wake versions.
- Updated the `better-effect` peer range to `>=0.14.0 <0.15.0` and aligned the
  MQ/outbox workspace peer artifacts with the current `0.1.x` releases.

## [0.1.2] - 2026-09-09

### Fixed

- Follow up the documentation release with a release-workflow fix that builds
  shared MQ workspace artifacts before consumer validation and runs this
  package's external consumer smoke test against the materialized builds.

## [0.1.1] - 2026-09-09

- Refresh the public README with current MySQL adapter journeys, transaction,
  Flow, outbox, and QueueControls documentation.

## [0.1.0]

- Add the optional MySQL 8/InnoDB JobStore adapter for `better-effect-mq` protocol v1.

# Changelog

## Unreleased

- Add `MySqlOutbox.transaction` for adapter-owned connection and transaction
  lifecycle around domain writes and outbox appends; keep `appendIn` as the
  advanced caller-owned transaction escape hatch.
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

## [0.1.0]

- Add the optional MySQL 8/InnoDB JobStore adapter for `better-effect-mq` protocol v1.

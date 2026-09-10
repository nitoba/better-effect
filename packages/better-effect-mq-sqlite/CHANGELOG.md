# Changelog

## Unreleased

- Add QueueControls protocol v3 support with durable controls, persisted dispatch keys, atomic
  global/per-key permits, fixed-window rate limits, bounded rotating candidate scans, recovery
  fencing, and SQLite migration 5.
- Add SQLite migration 3 and durable `OutboxStore` support with transactional append, leases,
  recovery, settlement, administration, named layers, and Bun/Node file layers.
- Add the adapter-owned `SqliteOutboxTransactions.transaction` helper for serialized domain-write
  and outbox transactions with automatic commit, rollback, and cleanup.
- Updated the `better-effect` peer range to `>=0.14.0 <0.15.0` and aligned the
  MQ/outbox workspace peer artifacts with the current `0.1.x` releases.

## [0.1.1] - 2026-09-09

- Refresh the public README with current SQLite adapter journeys, transaction,
  Flow, outbox, and QueueControls documentation.

## [0.1.0]

- Initial embedded SQLite JobStore and JobScheduleStore adapters.

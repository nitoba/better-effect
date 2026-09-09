# Changelog

## Unreleased

- Add QueueControls protocol v3 support with durable controls, persisted dispatch keys, atomic
  global/per-key permits, fixed-window rate limits, bounded rotating candidate scans, recovery
  fencing, and SQLite migration 5.
- Add SQLite migration 3 and durable `OutboxStore` support with transactional append, leases,
  recovery, settlement, administration, named layers, and Bun/Node file layers.

## [0.1.0]

- Initial embedded SQLite JobStore and JobScheduleStore adapters.

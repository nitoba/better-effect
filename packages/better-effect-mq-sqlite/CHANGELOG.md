# Changelog

## Unreleased

- Fix schedule cloning to copy validated, already-decoded JSON instead of parsing
  scalar strings a second time. Values such as `"null"`, `"123"`, `"true"`, and
  JSON-looking object/array strings retain their type across reads, upserts,
  pause/resume, and accepted or stale ticks (issue #390).
- Add native regressions inspecting both returned records and persisted schedule
  and emitted-job payload columns. Extend the installed-package consumer to run
  Node and Bun file-reopen checks against the actual packed adapter.
- Keep schema/migration checksums, occurrence fencing, namespaces, and dependency
  versions unchanged. This prevents new corruption; previously overwritten
  payloads require an authoritative original value and are not repaired
  automatically. This entry does not indicate an npm publication.

## [0.1.2] - 2026-09-10

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

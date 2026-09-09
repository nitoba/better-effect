# Changelog

## Unreleased

- Add `MongoOutbox.transaction(clientOrDb, preparedRecord, callback, options?)`
  for adapter-owned MongoDB session and transaction lifecycle around domain
  writes and automatic outbox appends; preserve `appendIn` as the advanced
  caller-owned escape hatch.
- Add MongoDB QueueControls protocol v3 support with durable revisioned
  controls, persisted dispatch keys, transactional global/per-key permits,
  anchored fixed-window rate limits, bounded fairness cursors, fail-closed
  legacy claims, and owner-fenced settlement/recovery.
- Advance the MongoDB layout to version 4 with dedicated controls, permits,
  rate-window, and fairness-cursor collections and indexes.
- Add the protocol-v2 `MongoFlowStore` with explicit flow migration, atomic
  child settlement reports, durable flow outbox delivery, and named layers.
- Add the durable `MongoJobEventStore` with namespace-scoped monotonic cursors,
  filtered pagination, explicit age/count retention, polling fallback, and
  change-stream wake hints.
- Advance the MongoDB layout to version 5 with validated events and cursor
  collections. Event-enabled JobStore layers append transition events in the
  same MongoDB transaction as the state change.

## [0.1.3] - 2026-09-09

### Fixed

- Add repository metadata required for npm Trusted Publishing provenance on the
  next MongoDB adapter release.

## [0.1.2] - 2026-09-09

### Fixed

- Follow up the documentation release with a release-workflow fix that builds
  shared MQ workspace artifacts before consumer validation and runs this
  package's external consumer smoke test against the materialized builds.

## [0.1.1] - 2026-09-09

- Refresh the public README with current MongoDB adapter journeys, transaction,
  Flow, outbox, and QueueControls documentation.

## [0.1.0] - 2026-09-04

Initial MongoDB JobStore adapter for protocol v1.

- Require a transaction-capable replica set or mongos deployment.
- Add explicit, forward-only collection migration and layout validation.
- Add caller-owned and config-owned Mongo client layers.
- Add a durable `OutboxStore` with caller-owned transactional append,
  request-digest deduplication, fenced leases, heartbeat, recovery, and
  settlement operations.

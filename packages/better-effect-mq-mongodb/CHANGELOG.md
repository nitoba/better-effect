# Changelog

## Unreleased

- Add the protocol-v2 `MongoFlowStore` with explicit flow migration, atomic
  child settlement reports, durable flow outbox delivery, and named layers.

## [0.1.0] - 2026-09-04

Initial MongoDB JobStore adapter for protocol v1.

- Require a transaction-capable replica set or mongos deployment.
- Add explicit, forward-only collection migration and layout validation.
- Add caller-owned and config-owned Mongo client layers.
- Add a durable `OutboxStore` with caller-owned transactional append,
  request-digest deduplication, fenced leases, heartbeat, recovery, and
  settlement operations.

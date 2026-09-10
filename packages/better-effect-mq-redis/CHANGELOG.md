# Changelog

## Unreleased

- Add the Redis-native `RedisOutbox.transaction` callback and durable
  `RedisOutboxStore` Layer. The callback owns `MULTI`/`EXEC` cleanup for a
  Redis domain write plus outbox append and documents the boundary as
  Redis-only rather than cross-database atomicity.
- Atomically append terminal Flow child reports to the Redis JobStore outbox for settlement, cancellation, release, retry exhaustion, and stalled recovery, with at-least-once relay support.
- Implement QueueControls protocol v3 with revision fencing, atomic permits, persisted `dispatchKey`, fixed-window rate limits, and controlled lifecycle transitions.
- Updated the `better-effect` peer range to `>=0.14.0 <0.15.0` and aligned the
  MQ/outbox workspace peer artifacts with the current `0.1.x` releases.

## [0.1.2] - 2026-09-09

### Fixed

- Follow up the documentation release with a release-workflow fix that builds
  shared MQ workspace artifacts before consumer validation and runs this
  package's external consumer smoke test against the materialized builds.

## [0.1.1] - 2026-09-09

- Refresh the public README with current Redis adapter journeys, transaction,
  Flow, outbox, and QueueControls documentation.

## [0.1.0] - 2026-09-03

Initial release of `better-effect-mq-redis`.

- Add the Redis/Valkey client and explicit command/subscriber ownership.
- Add canonical Cluster-safe key layout and safe-integer member helpers.
- Add validated JobRecord/AttemptRecord codecs and layout marker checks.
- Ship Lua foundation scripts and bounded `EVALSHA`/`NOSCRIPT` recovery.

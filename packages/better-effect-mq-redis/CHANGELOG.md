# Changelog

## Unreleased

- Atomically append terminal Flow child reports to the Redis JobStore outbox for settlement, cancellation, release, retry exhaustion, and stalled recovery, with at-least-once relay support.
- Implement QueueControls protocol v3 with revision fencing, atomic permits, persisted `dispatchKey`, fixed-window rate limits, and controlled lifecycle transitions.

## [0.1.0] - 2026-09-03

Initial release of `better-effect-mq-redis`.

- Add the Redis/Valkey client and explicit command/subscriber ownership.
- Add canonical Cluster-safe key layout and safe-integer member helpers.
- Add validated JobRecord/AttemptRecord codecs and layout marker checks.
- Ship Lua foundation scripts and bounded `EVALSHA`/`NOSCRIPT` recovery.

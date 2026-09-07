# Changelog

## Unreleased

- Implement QueueControls protocol v3 with revision fencing, atomic permits, persisted `dispatchKey`, fixed-window rate limits, and controlled lifecycle transitions.

## [0.1.0] - 2026-09-03

Initial release of `better-effect-mq-redis`.

- Add the Redis/Valkey client and explicit command/subscriber ownership.
- Add canonical Cluster-safe key layout and safe-integer member helpers.
- Add validated JobRecord/AttemptRecord codecs and layout marker checks.
- Ship Lua foundation scripts and bounded `EVALSHA`/`NOSCRIPT` recovery.

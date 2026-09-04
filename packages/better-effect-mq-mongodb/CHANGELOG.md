# Changelog

## [0.1.0] - 2026-09-04

Initial MongoDB JobStore adapter for protocol v1.

- Require a transaction-capable replica set or mongos deployment.
- Add explicit, forward-only collection migration and layout validation.
- Add caller-owned and config-owned Mongo client layers.

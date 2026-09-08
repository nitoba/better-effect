# Changelog

## Unreleased

### Added

- Immutable `PreparedEnqueue` producer commands and the optional prepared
  enqueue capability on the in-memory JobStore.
- Layer-first `Worker.service(tag).layer(factory)` startup and Runtime-owned
  quiesce/release lifecycle, plus caller-owned `Worker.succeed` test doubles.
- Retry policies with durable backoff normalization, typed failure handling,
  cooperative job timeouts, and best-effort failure notifications.
- Process-local JobEvent observers, logging and metrics adapters, RecordedJobObserver,
  Runtime attempt metadata, and opt-in queue-depth sampling.
- Process-local `JobHealth` snapshots and sinks for store failures, lease/stall
  signals, consumer failures, event lag, retention, cursor expiry, and safe metrics.
- Flow v2 phase handlers and associated `FlowStore` requirements for Layer-first
  Worker route validation, including duplicate-route checks.
- Layer-owned Flow v2 relay and bounded reconciliation/sweeper supervision,
  including at-least-once outbox delivery and graceful Runtime shutdown.
- The deterministic TestJobStore harness, end-to-end examples, MQ documentation,
  and package/type-system release gates.

## [0.1.0] - 2026-08-31

### Added

- Experimental storage-neutral durable message-queue protocol foundations.
- Portable codecs, immutable versioned Job definitions, JobStore contracts, and
  the in-memory reference store.
- Runner-agnostic JobStore conformance scenarios under `/testing`.

### Compatibility

- Requires `better-effect` `>=0.13.0 <0.14.0` and `better-result` `^3.0.0`.
- Supports TypeScript `>=5.7.0` and the Node.js/Bun runtime matrix used by the
  repository.

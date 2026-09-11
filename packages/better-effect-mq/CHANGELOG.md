# Changelog

## [0.1.3] - 2026-09-11

### Fixed

- Complete durable PostgreSQL fan-out under its original lease and run Collect
  only after a new claim. Retain execution capacity until phase Scope cleanup
  finishes, preventing an extra acquisition of an empty flow parent.
- Route terminal child reports by FlowStore identity and rotate bounded recovery
  across routes, parents, and pending children so later flows are not starved.
- Preserve phase-local JobContext while retaining external business Service
  requirements in Worker layers.
- Distinguish deliberate notification and claim cancellation during quiescence
  from storage deadlines without weakening late-claim fencing.

### Compatibility

- Add the optional FlowStore parentLeaseMode descriptor. Existing independent
  stores retain their previous lease lifecycle when the field is omitted.
- PostgreSQL handoff requires better-effect-mq-postgres 0.1.4 or newer. The
  frozen v1 JobRecord inspection API is unchanged; suspended-parent inspection
  still requires the explicit FlowStore/v2 boundary.
- Regression coverage includes held Scope cleanup, repeated concurrency-one
  execution, mixed child failures, nested flows, cancellation, and installed
  Nest consumers using Node and Bun.

## [0.1.2] - 2026-09-10

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

### Compatibility

- Updated the `better-effect` peer range to `>=0.14.0 <0.15.0`.

## [0.1.1] - 2026-09-09

### Changed

- Refreshed the public README with schema-first Flow, outbox, and adapter
  documentation and runnable examples.

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

# Changelog

## Unreleased

### Added

- Retry policies with durable backoff normalization, typed failure handling,
  cooperative job timeouts, and best-effort failure notifications.
- Process-local JobEvent observers, logging and metrics adapters, RecordedJobObserver,
  Runtime attempt metadata, and opt-in queue-depth sampling.

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

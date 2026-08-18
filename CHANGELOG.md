# Changelog

## [0.9.0] - 2026-08-18

### Added

- Requirement-aware `Effect` observation, recovery, matching, transformation,
  collection, and `Program.all` helpers.
- Rich Service acquisition diagnostics for missing, circular, and failed
  providers.
- Optional `better-effect/standard-services` modules for Clock, Random,
  Logger, CurrentRequest, and the existing abort-signal bridge.

### Compatibility

- Existing Result, Layer, Runtime, Scope, Resource, and DI adapter APIs remain
  compatible. Standard services are opt-in and never installed implicitly.

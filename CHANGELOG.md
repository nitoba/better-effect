# Changelog

## [0.10.0] - 2026-08-28

This release contains Runtime and integration hardening for the 0.10.0 line.

### Changed

- Hardened Runtime context and Scope ownership: the published Runtime entrypoint
  is officially supported on Node.js and Bun, default context propagation uses
  Node/Bun async context support, and graceful disposal waits for active work
  before root and backend cleanup.
- Bounded `Program.all` stops scheduling new programs after a failure while
  allowing already-started programs to settle and preserving a deterministic
  primary failure.
- Hono's default failure policy redacts every non-`Response` failure to a generic
  500 response; explicitly returned `Response` failures are intentionally passed
  through unchanged.
- Runtime, Layer, and Hono boundaries retain Service requirements and reject
  incompatible provider or request-boundary contracts at their typed edges.

### Migration notes

- Use the default Node/Bun context storage for overlapping executions. The
  `better-effect/runtime/explicit` subpath is only a manually managed,
  sequential strategy when the package entrypoint and host can load it; one
  instance supports one non-overlapping flow and rejects concurrent overlap.
  It does not make the package generally usable in browsers, Deno, Cloudflare
  Workers, or other non-Node hosts, and separate explicit instances are not a
  general concurrent-isolation strategy.
- Review custom Hono failure handlers that expose exception details. Return safe,
  intentional domain details explicitly; `Response` failures returned by the
  program continue to pass through unchanged.
- Do not rely on forced cancellation during Runtime disposal. Active programs
  may settle before root cleanup; use `AbortSignal` for cooperative cancellation.

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

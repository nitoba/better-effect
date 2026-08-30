# Changelog

## Unreleased

### Planned for `better-effect-better-auth` v0.2

- Optional Hono request-scoped current-session integration from the `/hono`
  entry point; this is planned work and is not part of the released v0.1 API.
- The v0.2 gate will cover the Hono peer, request snapshot lifecycle, route
  ordering/base-path guidance, and external current/minimum runtime consumers.

## [better-effect-better-auth@0.1.0] - 2026-08-30

### Added

- The first independent `better-effect-better-auth` release, adapting an
  existing Better Auth server to typed `better-effect` Services and Layers.
- Result-oriented endpoint data, Web `Response`, and `{ response, headers }`
  transport modes, session `get`/`require` helpers, and the Web-standard
  handler bridge.
- Plugin-preserving type inference for endpoints, User/Session fields, and
  Better Auth error codes, with `BetterAuthApiError` and explicit
  `Unauthenticated` failures.

### Tested peer matrix

| Peer            | Minimum tested | Current tested |
| --------------- | -------------- | -------------- |
| `better-auth`   | `1.7.0`        | `1.7.2`        |
| `better-effect` | `0.12.0`       | `0.13.0`       |
| `better-result` | `3.0.0`        | `3.0.0`        |
| TypeScript      | `5.7.2`        | `6.0.3`        |

The release gate also runs the packed consumer on Node.js `24.x` and Bun
`1.3.14`. The declared peer ranges remain Better Auth `^1.7.0`, better-effect
`>=0.12.0 <0.14.0`, better-result `^3.0.0`, and TypeScript `>=5.7.0`.

### v0.1 non-goals

- server-side only in v0.1;
- no client hooks or React/Vue/Svelte/Solid adapters;
- no framework middleware helpers or framework subpaths;
- no implicit `CurrentAuthSession` or request-scoped session integration;
- no roles, policy, or authorization engine;
- no automatic conversion to application-domain failures;
- no retry, timeout, or circuit-breaker policies;
- no database adapter;
- no database migrations;
- no environment or configuration ownership;
- no Runtime or dependency-container ownership;
- no official Better Auth-maintained integration or compatibility guarantee.

The package adapts an existing Better Auth instance and does not create or own
Better Auth, database, environment, Runtime, or dependency-container
lifecycle. Better Auth remains responsible for its public server APIs and
plugin compatibility.

## [0.13.0] - 2026-08-30

### Added

- Framework-neutral `better-effect/web` with `WebEffect.handle`, typed
  request-local Layers, `CurrentRequest`/AbortSignal propagation, safe Response
  policies, and deterministic request Scope cleanup.
- Optional `better-effect/opentelemetry` with `OpenTelemetryRuntimeObserver` for
  correlated, privacy-preserving Runtime execution and Service telemetry.
- Optional `better-effect/next` for Next.js 16.3.0 App Router Route Handlers,
  including typed asynchronous route context and application-owned Runtime
  lifecycle guidance.
- Optional `better-effect/bun` with a typed `Bun.serve` fetch handler adapter
  and Bun server lifecycle guidance.

### Changed

- `HonoEffect` now delegates its shared request lifecycle to `WebEffect` while
  preserving Hono middleware order, Context inference, typed failure behavior,
  guard Scope outcomes, and defect handling.

### Compatibility

- Existing HonoEffect APIs remain source compatible. Web, Next, Bun, and
  OpenTelemetry integrations are opt-in subpaths; core and the main entrypoint
  remain free of framework and telemetry runtime dependencies.

## [0.12.0] - 2026-08-29

### Added

- `better-effect/node` with `NodeRuntime.runMain` for typed Node/Bun main
  Programs, cooperative signal handling, graceful cleanup, exit-code policies,
  and fresh packed-package lifecycle coverage under both hosts.
- Lazy `Program.named` metadata and per-execution attributes, stable execution
  IDs, monotonic durations, and correlated Runtime observer events.
- `RuntimeGraphObserver` in `better-effect/testing`, with immutable
  deterministic JSON/Mermaid graph snapshots and safe Mermaid label rendering.
- Immutable, synchronous `runtime.inspect()` diagnostic snapshots for Runtime
  lifecycle, warmup, active executions, and registered Service tags.
- Cancellable `Clock.sleep` plus deterministic `ClockTest` scheduling helpers:
  `pendingSleeps`, `advanceToNext`, and guarded `runAll`.
- Opt-in `IdGenerator`, `IdGeneratorLive`, and deterministic `IdGeneratorTest`
  Standard Services.
- An experimental `better-effect-mq` package foundation with explicit package
  boundary and packed-consumer checks; its public entrypoints intentionally
  remain inert pending a later roadmap phase.

### Changed

- Runtime/Layer Service tags are validated as non-empty primitive strings,
  made immutable, and captured before asynchronous backend boundaries.
- Runtime observer metadata and inspection snapshots are detached and immutable
  even under concurrent execution and hostile observer/input mutation.

### Compatibility

- `Clock.sleep(milliseconds)` remains supported; cancellation uses its optional
  second options argument.
- Existing Runtime, Layer, Program, Scope, Resource, and Standard Service APIs
  remain compatible; diagnostics are additive and side-effect free.

## [0.11.0] - 2026-08-29

### Added

- Official testing tools: `RecordedRuntimeObserver`, safe observer composition,
  runner-agnostic `LayerBackend`/`RuntimeContextStorage` conformance kits, and
  `TestRuntime` for isolated, automatically disposed application tests.
- Lazy `Program` transformation, observation, recovery, bounded collection, and
  typed result-collection combinators, including `Program.forEach` and
  `Program.allResults`.
- Requirement-preserving asynchronous Effect taps and tagged-error matching.
- `Effect.acquireReleaseResult` and `Effect.acquireDisposable`, plus
  `Layer.scopedDisposable`, for Result-aware and protocol-based scoped resource
  acquisition.
- `Layer.empty` and lazy, contract-preserving `Layer.alias({ from, to })`.

### Changed

- Hono route helpers now infer variadic middleware input, environment, and path
  types across an entire middleware tuple and reject repeated `next()` calls
  without re-executing a Program.
- Layer override and TestRuntime option inference now retain only Services
  guaranteed across union branches while validating every possible collision.
- Layer aliases and the shared empty Layer are hardened against unsound union
  tokens and JavaScript mutation.

### Compatibility

- Existing `Effect.acquireRelease`, `Effect.add`, `Layer.scoped`,
  `Layer.scopedGen`, Resource APIs, and Hono routes remain compatible.

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

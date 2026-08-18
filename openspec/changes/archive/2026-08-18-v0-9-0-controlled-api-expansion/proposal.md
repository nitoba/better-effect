## Why

The 0.8 API proves that `Effect` can preserve typed Service requirements, but larger workflows still fall back to raw `better-result` combinators and lose that metadata. Version 0.9.0 should expand the small API in controlled, reviewable increments while making runtime infrastructure failures diagnosable and keeping test-friendly contextual services optional.

## What Changes

- Add requirement-aware `Effect` observation, recovery, transformation, matching, and combination helpers: `tap`, `tapError`, `tapBoth`, `recover`, `recoverAsync`, `flatten`, `as`, `asVoid`, `match`, `all`, and `zip`.
- Add lazy `Program` collection/parallelism helpers so concurrent work starts only after a Runtime has installed its context; expose bounded concurrency as an explicit option.
- Preserve the current two-channel `Layer<Provided, Required>` model. Do not add `BuildError`, `Layer.effect`, or `Runtime.makeResult` in this release.
- Formalize Service construction failures as infrastructure defects with rich `ServiceAcquisitionError`, `CircularDependencyError`, and `ServiceNotFoundError` diagnostics; domain errors remain owned by Service methods.
- Add small optional standard-service modules for deterministic time, randomness, logging, request context, and the existing abort-signal bridge. Keep product-specific Config, Cache, HTTP, and database integrations outside core.
- Make each implementation task below a PR-sized unit. Every PR must include its runtime/type tests and affected docs/examples, and pass `bun run check` before merge.
- Reserve the final PR for 0.9.0 integration, package metadata, changelog/release validation, and confirmation that all preceding PRs compose without widening `R`.

## Capabilities

### New Capabilities

- `effect-combinators`: requirement-aware observation, recovery, transformation, matching, and sequential combination helpers.
- `program-combinators`: lazy Program collection and bounded-concurrency execution.
- `service-acquisition-errors`: typed infrastructure diagnostics for missing, circular, and failed Service acquisition.
- `standard-services`: optional Clock, Random, Logger, CurrentRequest, and CurrentAbortSignal services with test-oriented implementations.

### Modified Capabilities

- `typed-layer-requirements`: Effect combinators and composed Programs must preserve or union tagged Service instance requirements without changing the two-channel Layer contract.
- `typed-runtime-execution-requirements`: Program execution and concurrent helpers must validate their complete final requirement union at Runtime boundaries.

## Impact

The main impact is in `packages/better-effect/src/effect`, `src/service`, `src/runtime`, and new optional standard-service modules, plus type/runtime tests, documentation, and the todo example where usage changes. No new runtime dependency is planned. Existing Result semantics remain delegated to `better-result`; existing `CurrentAbortSignal` behavior remains compatible. The advanced Layer build-error channel and domain-specific services are explicitly deferred.

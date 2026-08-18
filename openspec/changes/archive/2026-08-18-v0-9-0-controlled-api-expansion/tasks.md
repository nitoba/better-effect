## 1. Observation and recovery combinators

- [x] 1.1 **PR-01 — Add `Effect.tap`, `Effect.tapError`, and `Effect.tapBoth`**: implement the thin Result adapters, preserve the exact requirement channel, export the helpers, and add runtime/type tests plus focused docs examples.
- [x] 1.2 **PR-02 — Add `Effect.recover` and `Effect.recoverAsync`**: mirror `better-result` recovery semantics, include fallback error and requirement inference, and cover success bypass, fallback success, fallback failure, async behavior, and public declarations.

## 2. Value transformations and matching

- [x] 2.1 **PR-03 — Add `Effect.flatten`, `Effect.as`, and `Effect.asVoid`**: implement only the missing adapters, union nested channels where required, and add exact type tests for nested Effects, errors, and Services.
- [x] 2.2 **PR-04 — Add requirement-aware `Effect.match`**: support plain branch values and Effect-valued handlers, invoke only the selected branch, union possible handler channels statically, and document both forms.

## 3. Existing Effect collections

- [x] 3.1 **PR-05 — Add `Effect.all` and `Effect.zip`**: collect already-created Effects in input order, preserve `better-result` short-circuiting, union every error and requirement channel, and add heterogeneous tuple fixtures and Runtime boundary tests.

## 4. Lazy Program concurrency

- [x] 4.1 **PR-06 — Add lazy `Program.all` with bounded concurrency**: expose the value-level helper, validate positive integer limits, implement the minimal FIFO worker pool, preserve tuple order, and verify that construction invokes no Program.
- [x] 4.2 **PR-07 — Integrate Program requirement metadata with Runtime boundaries**: make `Program.all` expose the complete union of child requirements, reject missing Services before execution with `MissingDependencies`, and test context, Scope ownership, in-flight cleanup, and TypeScript 5.7.2 declarations.

## 5. Service acquisition diagnostics

- [x] 5.1 **PR-08 — Harden infrastructure acquisition errors**: verify and adjust resolver boundaries so missing, circular, and provider-failure cases expose logical tags, ordered paths, exact causes, and no adapter identifiers or double wrapping; add runtime tests, type-facing error assertions, and docs.

## 6. Optional standard-service modules

- [x] 6.1 **PR-09 — Add the optional standard-services entrypoint and Clock**: add the package subpath/build entry, define the smallest Clock contract, provide the host implementation and `ClockTest`, and add export, layer, runtime, and declaration fixtures.
- [x] 6.2 **PR-10 — Add Random and `RandomSeeded`**: provide a reproducible seeded implementation with isolated state, layer replacement tests, and package/type coverage through the optional entrypoint.
- [x] 6.3 **PR-11 — Add Logger and `LoggerTest`**: define structured event capture, provide the production bridge and ordered test sink, verify logging does not alter Effect values, and update docs.
- [x] 6.4 **PR-12 — Add CurrentRequest and preserve CurrentAbortSignal compatibility**: keep request and signal values execution-local, re-export the existing signal bridge without duplicate runtime state, and test concurrent isolation plus the no-signal fallback.

## 7. Integration and release

- [x] 7.1 **PR-13 — Complete cross-feature documentation and package contract checks**: update README/docs and the todo example where the public usage changed, verify root and subpath exports, add minimum-TypeScript fixtures, and run the full `bun run check` with all feature PRs applied.
- [x] 7.2 **PR-14 — Release 0.9.0**: update package version/changelog and release metadata, run the publish/version validation, and confirm the tag/version guard passes only for `v0.9.0`.

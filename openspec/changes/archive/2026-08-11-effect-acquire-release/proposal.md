## Why

Resource acquisition inside `Effect.gen` currently exposes the contextual `Scope` for a common acquire-and-release pattern. A small yieldable `Effect.acquireRelease` helper can keep ownership and cleanup in Scope while making scoped resources feel native to the Effect API.

## What Changes

- Add `Effect.acquireRelease(acquire, release)` as a yieldable operation for `Effect.gen`.
- Run acquisition in the current contextual Scope and register the release callback in that Scope before returning the resource.
- Preserve typed Effect error inference for acquisition failures, using `better-result`'s existing `UnhandledException` normalization for thrown or rejected operations.
- Keep release execution under Scope lifecycle semantics; release failures remain cleanup failures rather than introducing outcome-aware errors.
- Preserve the invariant that Scope is not added to `EffectRequirements`.
- Add runtime and type-level tests plus focused documentation examples.
- Do not add `Effect.add`, outcome-aware finalizers, `Exit`, `Cause`, cancellation, or Resource deprecation in this change.

## Capabilities

### New Capabilities

- `effect-acquire-release`: ergonomic acquire-and-release operations that integrate contextual Scope lifetimes with `Effect.gen`.

### Modified Capabilities

<!-- No existing capability requirements change. Scope remains the lifecycle owner. -->

## Impact

- Extends the public `Effect` API and its type-level yield/error inference.
- Affects `src/effect`, Effect tests/type tests, and the relevant README documentation.
- Reuses `Scope.current()` and `Scope.acquire()`; it adds no runtime dependency and does not modify Resource or DI adapters.
- The new operation returns a yieldable async generator compatible with the existing `Result.gen` integration.

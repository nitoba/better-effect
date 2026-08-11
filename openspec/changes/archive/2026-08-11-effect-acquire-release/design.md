## Context

The current `Effect.gen` implementation delegates generator execution to `better-result` and already accepts `Result.await(...)` as an async yieldable. `Scope.acquire()` owns acquisition races, finalizer registration, and immediate cleanup when a Scope begins closing. See `proposal.md` and the new capability spec for the user-visible contract.

## Goals / Non-Goals

**Goals:**

- Add one small `Effect` operation that composes with the existing async generator and Result control flow.
- Reuse `Scope.current()` and `Scope.acquire()` without creating another lifecycle abstraction.
- Keep acquisition failures in the Effect Result error channel and keep release failures in Scope cleanup.
- Preserve exact acquired-resource inference and the existing Service-only requirement channel.

**Non-Goals:**

- No synchronous-generator variant; the operation is an async yieldable like `Result.await`.
- No `Effect.add`, automatic disposable detection, `Exit`, `Cause`, cancellation, outcome-aware finalizers, or transaction commit/rollback policy.
- No changes to `Resource.acquireUseRelease()` or Resource deprecation status.
- No support for acquire callbacks that return `Result`; callers that need that shape remain responsible for composing the Result explicitly.

## Decisions

### Implement the operation as a Result-compatible async generator

`Effect.acquireRelease()` will capture the current Scope and return `Result.await(...)` around a `Result.tryPromise(...)` that invokes `scope.acquire(acquire, release)`. This yields the acquired resource while exposing only the existing `Err` yield shape to `Effect.gen`.

This is preferred over returning a raw Promise because `yield* Effect.acquireRelease(...)` then participates in the same generator protocol as Services and `Result.await`. A custom Effect operation interpreter would add a second execution protocol for one helper and is unnecessary.

The current Scope is captured when the operation is constructed inside the generator. If no Scope is configured, `Scope.current()` raises the existing context error before acquisition begins; no resource or finalizer is created.

### Normalize only acquisition failures

The acquire operation is wrapped with `Result.tryPromise`, so synchronous throws and rejected promises become `UnhandledException` errors in the Result channel. The release callback is registered only after successful acquisition and remains a Scope finalizer; its failure is therefore reported by Scope/Runtime closure rather than converted into an Effect `Err`.

This keeps the operation compatible with the existing error model and avoids pretending that a release occurring after the generator result has completed can be represented as an ordinary in-band Effect error.

### Preserve the existing Effect type machinery

The returned generator has the shape `AsyncGenerator<Err<never, UnhandledException>, R, unknown>`. Existing `EffectYield`, `InferYieldError`, `EffectSuccess`, and `EffectRequirements` machinery can therefore infer the resource type and acquisition error without changes to the phantom Scope contract.

`acquireRelease` will be added to the `Effect` object and its implementation module. It will not be exported as a separate top-level package symbol unless the existing Effect export pattern requires it.

### Test behavior at both runtime and compile time

Runtime tests will run the helper under `Scope.run()`/Runtime and cover success, Result errors, thrown/rejected programs, acquisition failures, release failures, and missing Scope context. Type tests will assert exact resource success inference, `UnhandledException` in the error channel, no Scope requirement, and unioning with Service requirements.

## Risks / Trade-offs

- **Release failures reject the owning Scope/Runtime Promise instead of returning an Effect Err** → Document this as existing Scope cleanup behavior and test it explicitly; outcome-aware finalizers remain a later change.
- **`Scope.current()` is required when the operation is constructed** → This matches contextual Effect execution and fails early with the existing context error rather than silently leaking a resource.
- **`UnhandledException` is broad for arbitrary acquire failures** → Keep the raw acquire signature small and consistent with `better-result`; typed domain failures can be represented by a future Result-aware helper without conflating APIs now.
- **Async-only yieldability may surprise synchronous generator users** → Follow the established `Result.await` model and document that the helper belongs in async `Effect.gen` programs.
- **Resource and Effect helpers could drift semantically** → Reuse Scope directly and add shared lifecycle regression tests without changing Resource implementation.

## Migration Plan

1. Add the helper and expose it on `Effect` without changing existing exports or Resource.
2. Add runtime and type-level tests, then document the new acquire/release form alongside the existing Scope form.
3. Run `bun run check` and `bun pm pack --dry-run`.

Rollback is a source-only revert; no data, dependency, or package-format migration is required.

## Why

The repository already implements hierarchical Scopes and graceful Runtime disposal, but two failure paths are not yet robust: Runtime execution cleanup can mask the original program failure, and a re-entrant disposal call can begin before the execution has been registered as active. These gaps can release execution resources too early or hide the error that callers need to diagnose.

This hardening keeps the existing Scope/Layer/Runtime model while making execution ownership and cleanup behavior consistent across standalone Scopes and Runtime executions.

## What Changes

- Add the internal `runScoped` lifecycle helper and use it for both `Scope.run()` and Runtime execution cleanup.
- Preserve both program and Scope-cleanup failures when an execution fails in both places, without changing `Resource`.
- Register or reserve a Runtime execution before user code can invoke re-entrant disposal, so root shutdown never closes a still-running execution Scope.
- Preserve graceful disposal ordering: reject new runs, await already-registered executions, close the root Scope, then dispose the backend.
- Keep disposal idempotent and keep the existing `BuiltLayerDisposedError` for runs attempted during `disposing` or after `disposed`.
- Add regression tests for combined failures, registration/disposal races, cleanup ordering, nested Scope context restoration, and concurrent Runtime isolation.
- Align README and lifecycle guidance with the hardened ownership guarantees; do not add cancellation, timeouts, Fibers, or new Resource APIs.

## Capabilities

### New Capabilities

<!-- No new capability is introduced; this change hardens an existing one. -->

### Modified Capabilities

- `scope-hierarchy-runtime-shutdown`: strengthen Runtime execution ownership, cleanup error preservation, and graceful-disposal ordering guarantees.

## Impact

- Affects `src/scope` internals and `src/layer/runtime.ts`; the public `Scope`, `BuiltLayer`, and `Runtime` shapes remain otherwise unchanged.
- Adds no runtime dependencies and does not modify `Resource` or DI adapter ownership semantics.
- Extends scope and layer-runtime tests plus lifecycle documentation.
- The existing archived implementation remains the baseline; this change is a corrective follow-up rather than a second Runtime abstraction.

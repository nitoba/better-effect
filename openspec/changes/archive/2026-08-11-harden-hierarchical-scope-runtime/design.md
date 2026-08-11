## Context

The current implementation already owns Layer resources with a root Scope and execution resources with child Scopes. `Scope.run()` manually preserves program and cleanup failures, while `BuiltLayerImpl.runExecution()` uses a separate `try/finally` path. Runtime execution Promises are added to the active set only after `runExecution()` has begun invoking user code. See `proposal.md` and the modified capability spec for the required behavior.

## Goals / Non-Goals

**Goals:**

- Make standalone Scope and Runtime execution cleanup use one failure-preserving lifecycle path.
- Ensure an execution is visible to graceful disposal before its callback can call Runtime APIs.
- Keep child Scope closure before the execution Promise settles and keep root/backend shutdown ordering unchanged.
- Preserve the current public Runtime, Layer, Scope, and Resource APIs apart from the timing of the disposed-state guard.

**Non-Goals:**

- No cancellation, timeout, Fiber, `Exit`, `Cause`, or forced shutdown mechanism.
- No attempt to make awaiting `runtime.dispose()` from inside that same active execution complete; that remains a re-entrancy limitation without execution cancellation or identity tracking.
- No changes to Resource error semantics or DI adapter disposal ownership.

## Decisions

### Share one scope-running helper

Add an unexported `runScoped(scope, program)` helper under `src/scope/internal.ts`. It executes the program in the supplied Scope, waits for it, always closes the Scope, and records program and cleanup failures independently. If both fail, it throws an `AggregateError` with the program failure first.

`Scope.run()` delegates to this helper. `BuiltLayerImpl.runExecution()` also delegates to it, so Runtime executions no longer have a separate `finally` implementation that can mask the program error. Keeping the helper internal avoids expanding the package API.

### Reserve the active execution before invoking user code

`BuiltLayerImpl.run()` will perform its active-state check, fork the child Scope, create a deferred Promise representing the execution, and add that Promise to `executions` before starting `runExecution()`. The actual execution Promise resolves or rejects the reserved Promise after `runScoped()` completes. This preserves the existing immediate callback-start behavior while ensuring a callback cannot initiate disposal before its execution is visible to the active set.

A microtask-only deferral was considered, but it would change the timing of synchronous program side effects. A placeholder Promise keeps the public method Promise-based without exposing a new deferred type.

### Keep disposal coordination explicit

`dispose()` changes state to `disposing` before it snapshots the active execution set. `performDispose()` receives that snapshot, waits with `Promise.allSettled()`, then runs root Scope cleanup inside the ServiceRuntime context and invokes `backend.disposeAll()` last. Execution failures are intentionally ignored by disposal coordination; the execution caller receives them, while root and backend cleanup still run.

The existing success/failure handlers remove settled Promises from `executions` and consume the derived Promise, avoiding unhandled-rejection noise. Repeated calls return the memoized disposal Promise.

### Preserve the existing type boundary

`BuiltLayer` and `Runtime` retain their current generic signatures, including `CompleteLayer` validation. The disposed-state assertion remains the existing `BuiltLayerDisposedError`; the implementation may perform that assertion synchronously before constructing an execution so the user callback is never invoked after disposal begins.

### Test the observable ordering and failure contracts

Add focused tests for combined program/cleanup failures, a callback that initiates disposal before its first yield, execution resources remaining alive until callback completion, root-finalizer-before-backend ordering, synchronous rejection of new runs if that contract is retained, nested Scope context restoration, and concurrent Runtime scope isolation. Keep existing Resource and ITI coverage as regression tests.

## Risks / Trade-offs

- **A program that awaits its own `runtime.dispose()` can deadlock** → Keep this limitation explicit; cancellation and execution identity are outside this change, and disposal tests initiate shutdown from outside the active execution or do not await it from within the callback.
- **A deferred placeholder adds Promise plumbing** → Localize it inside `BuiltLayerImpl.run()` and keep the externally returned type unchanged.
- **Changing the disposed-state guard from async rejection to a synchronous throw is observable** → Keep the same error class and document/test the chosen timing consistently; if compatibility requires Promise rejection, use an awaited rejection assertion instead.
- **Cleanup can still fail after a program failure** → Use the shared helper and stable `AggregateError` ordering, then retain the existing `ScopeCloseError` and `LayerDisposeError` wrappers.
- **Backend behavior may vary** → Keep ServiceRuntime active during root cleanup and do not move provider release responsibility into DI adapters.

## Migration Plan

1. Add the internal helper and refactor `Scope.run()` and Runtime execution cleanup to use it.
2. Change BuiltLayer execution registration to reserve the active Promise before invoking user code, then make disposal consume a stable snapshot.
3. Add regression tests and update README/AGENTS lifecycle guidance without changing Resource or adapter APIs.
4. Run `bun run check` and `bun pm pack --dry-run`.

Rollback is a source-only revert. No dependency, persisted data, or package format migration is required.

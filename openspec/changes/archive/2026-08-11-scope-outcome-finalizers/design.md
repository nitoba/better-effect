## Context

See `proposal.md` and the two delta specifications for the observable
contract. Today `Scope` is a class whose public instance type includes `close`,
`Scope.current()` exposes that same type, and `runScoped` combines program and
cleanup failures into an `AggregateError`. `Effect.acquireRelease` delegates
registration to the current Scope, while `BuiltLayerImpl` is the existing
boundary for Runtime execution tracking and graceful shutdown.

The implementation must preserve Scope’s independence from `better-result` and
must not allow a running Runtime program to close its owner Scope through the
normal contextual type. Existing callback forms, generic layer requirements,
Resource behavior, backend ordering, AsyncLocalStorage isolation, and the
ServiceRuntime context around root finalizers remain supported.

## Goals / Non-Goals

**Goals:**

- Separate lifetime use from lifetime ownership with a non-owning `Scope` and
  an owning `CloseableScope`.
- Carry one immutable final outcome through a Scope tree and into every
  finalizer belonging to that close operation.
- Classify only the complete Runtime result, preserving typed `Result.err`
  values and exact thrown exceptions.
- Keep cleanup failures observable as one aggregated diagnostic without letting
  them replace an already failed program, including one-shot root/backend
  shutdown.
- Make `Effect.acquireRelease` useful for commit/rollback-style release
  callbacks without adding a transaction abstraction.
- Preserve graceful Runtime shutdown ordering and public generic relationships.

**Non-Goals:**

- No Exit, Cause, Fiber, interruption, cancellation, timeout, forced shutdown,
  or outcome-aware Resource API.
- No Result import from `src/scope/**` and no change to Effect’s generator
  error propagation model.
- No automatic interpretation of intermediate Results or a union of request
  outcomes for a long-lived Runtime root.

## Decisions

### 1. Represent Scope use and Scope ownership separately

Replace the public instance surface with two types:

```ts
export interface Scope {
  addFinalizer(finalizer: ScopeFinalizer): void
  acquire<R>(
    acquire: () => MaybePromise<R>,
    release: (resource: R, outcome: ScopeOutcome) => MaybePromise<void>
  ): Promise<R>
  add<R extends DisposableResource>(resource: R): Promise<R>
  fork(): CloseableScope
}

export interface CloseableScope extends Scope {
  close(outcome?: ScopeOutcome): Promise<void>
}
```

The module continues to export the `Scope` value used by `yield* Scope`, but
its factory/current methods are typed as `make(): CloseableScope` and
`current(): Scope`. The implementation can use a private `ScopeImpl`; the
public value object/namespace preserves `Scope.make`, `Scope.current`,
`Scope.provide`, `Scope.run`, and the iterator protocol. `Scope.run` gives its
callback the non-owning `Scope` view while retaining the `CloseableScope`
privately for cleanup. `fork()` returns a `CloseableScope`, allowing a caller
to own and close a child without exposing the parent’s close operation.

This is a deliberate type-level breaking change: a program can still acquire
resources and register finalizers, but `Scope.current()` and `yield* Scope` no
longer provide `close()`.

### 2. Keep outcome data in Scope types and classify at boundaries

Add `ScopeOutcome` to `src/scope/types.ts` as a discriminated union with
`status: 'success'` and `status: 'failure'` plus `cause: unknown`. Add
`ScopeFinalizer` and release callback types whose outcome parameter is
required. Existing zero-argument/one-argument callbacks remain source
compatible because TypeScript permits functions to ignore trailing arguments.

`ScopeImpl` receives an outcome and forwards it; it never imports
`better-result`. Add `src/runtime/outcome.ts` for the Runtime-only classifier,
using the installed `Result` type guard and the Result error field. A plain
returned value is classified as success, `Result.ok` as success, and
`Result.err` as failure with its error. A thrown/rejected program bypasses the
classifier and directly creates a failure outcome with the thrown cause.

This keeps `Scope.run` generic: its default classifier treats any returned
value, including a Result, as success. Runtime execution supplies the
Result-aware classifier.

### 3. Make the first close call authoritative

`CloseableScope` stores a `closeOutcome` only when `close()` first creates the
close Promise. `close(outcome = success)` returns the existing Promise for all
later calls and ignores later outcomes. A parent passes its stored outcome to
each still-attached child; a child that has already begun closing retains its
own first outcome. A frozen/shared success value can be used internally, but
the union remains immutable to callers.

Finalizers are invoked as `finalizer(outcome)`. `scope.acquire` wraps its
release callback as `(outcome) => release(resource, outcome)`, so both the old
`release(resource)` form and the new `(resource, outcome)` form work.
Disposable-resource finalizers ignore the extra argument. `runScoped` accepts
only an owning `CloseableScope`, preventing it from accidentally closing a
non-owning contextual view.

### 4. Flatten cleanup causes at the Scope boundary

`closeInternal` continues child-first and LIFO processing. When a child rejects
with `ScopeCloseError`, its `causes` are appended to the parent failure list
instead of nesting the error. The parent then throws one `ScopeCloseError`
with all raw causes in traversal order. Cleanup continues after every failure,
and detachment remains in a finally-equivalent path so a failed close cannot
leak the child in its parent.

The Scope close operation itself never invokes an observer. A boundary catches
the resulting `ScopeCloseError`, which is the unit used for execution cleanup
diagnostics.

### 5. Centralize execution precedence in the boundary helper

Generalize `src/scope/internal.ts` to accept an outcome classifier and an
optional observer callback. Its algorithm is:

1. Run the program inside the supplied non-owning Scope context.
2. On throw/rejection, record the exact cause and close the owning Scope with
   failure.
3. On a returned value, classify it and close the owning Scope with that
   outcome.
4. If close fails, notify the observer once (best effort) with the chosen
   outcome and `ScopeCloseError`.
5. Return the original value for a classified failure (`Result.err`), rethrow
   the exact program cause for an exception, and throw the cleanup error only
   when the program outcome was success.

Observer invocation is wrapped in its own `try/catch`; it cannot affect the
program or cleanup result. With no observer, cleanup failure is suppressed only
when a program failure already exists. A successful program still rejects with
the cleanup error.

`Scope.run` uses an always-successful classifier and no observer. Runtime
execution supplies the Result-aware classifier and configured observer.

### 6. Use one observer API for execution and Runtime shutdown diagnostics

Execution cleanup diagnostics use:

```ts
type CleanupFailureDiagnostic = {
  readonly outcome: ScopeOutcome
  readonly error: ScopeCloseError
}
```

Runtime root/backend shutdown may produce a `LayerDisposeError` containing the
root `ScopeCloseError` followed by backend failures. The public observer type
therefore accepts a union of the execution diagnostic and a shutdown
diagnostic:

```ts
type RuntimeShutdownDiagnostic = {
  readonly outcome: ScopeOutcome
  readonly error: LayerDisposeError
}

type CleanupFailureObserver = (
  diagnostic: CleanupFailureDiagnostic | RuntimeShutdownDiagnostic
) => void | PromiseLike<void>
```

There is one observer call per execution close boundary and one per root/backend
shutdown boundary. Parent closure does not notify once per child. A direct
`CloseableScope.close()` has no observer and only returns its normal close
Promise.

### 7. Define one-shot Runtime shutdown precedence completely

Introduce `RuntimeOptions` with an optional cleanup observer and accept it as
the optional third argument to `buildLayer` and `Runtime.make`; the static
`Runtime.run` accepts it after the program. Store the observer in
`BuiltLayerImpl` and pass it to execution boundaries and root shutdown.

The one-shot runner captures the complete program outcome before starting
shutdown. It closes the execution child, closes the root with the same outcome,
and always attempts backend disposal. Root and backend failures are combined in
one `LayerDisposeError` in that order. If the program failed, the exact
`Result.err` or thrown cause remains the external result and the shutdown error
is reported only through the observer. If the program succeeded, the shutdown
error is the external rejection. Long-lived `Runtime.dispose()` always uses a
success root outcome and returns `LayerDisposeError` when root/backend cleanup
fails.

Layer registration failure closes the partial root with failure containing the
registration cause, attempts backend cleanup, and preserves the existing
`LayerRegistrationError` as the primary build error. Root finalizer execution
continues inside `ServiceRuntime.run`, so outcome-aware Layer finalizers can
still resolve Services.

The public `Runtime.dispose()` remains no-argument. The built runtime may use a
private outcome-aware disposal method, or an equivalent internal one-shot path,
but both paths MUST implement the same precedence above.

### 8. Preserve graceful shutdown ordering

`BuiltLayerImpl.run` keeps its active-execution registration before invoking
user code. Each execution calls the generalized boundary helper, so its child
Scope cannot be closed by the contextual type underneath a pending program.
`dispose()` still transitions to `disposing`, snapshots active executions,
waits with `Promise.allSettled`, closes the root inside `ServiceRuntime`, and
disposes the backend last. Execution failures remain outside the disposal
failure list; root/backend failures are aggregated after both phases are
attempted.

### 9. Update Effect typing without adding Scope requirements

Widen `Effect.acquireRelease`’s release callback to accept the acquired resource
and required `ScopeOutcome`, while returning the same AsyncGenerator success and
error types. The implementation continues to call `Scope.current()` and
`scope.acquire`; it does not create a Scope, expose a closeable type, or yield a
Scope requirement. Add type tests for both callback arities and runtime tests
for success, Result failure, exception, and cleanup failure outcomes.

## Risks / Trade-offs

- [Public type break] Consumers that call `Scope.current().close()` will no
  longer compile. → This is intentional ownership enforcement; callers that
  own a Scope use the `CloseableScope` returned by `Scope.make()` or `fork()`.
- [Changed error identity] Existing consumers that expect an `AggregateError`
  for program-plus-cleanup failure will observe the original program error
  instead. → Update tests and document the deliberate precedence; cleanup
  remains available through the configured observer.
- [Diagnostics can be missed] Without an observer, cleanup failures suppressed
  behind a program failure are not returned. → Make the observer opt-in but
  clearly document that it is the only diagnostic channel for that case.
- [Observer reentrancy] An observer could call Runtime APIs after cleanup and
  during disposal. → Invoke observers only after a boundary has produced its
  aggregate error, ignore observer failures, and keep Runtime state transitions
  ahead of all awaits.
- [Nested cleanup ordering] Flattening child errors can obscure which Scope
  failed if callers inspect only the aggregate list. → Preserve traversal/LIFO
  order and expose the aggregate in the diagnostic object.
- [Shutdown diagnostic union] Execution cleanup and root/backend shutdown use
  different error aggregates. → Keep the discriminating error classes public
  and document that `LayerDisposeError` contains root errors before backend
  errors.
- [Boundary mismatch] A Result-aware classifier accidentally used by generic
  `Scope.run` would make Scope depend on better-result semantics. → Keep the
  classifier injected and enforce imports so only `src/runtime/outcome.ts`
  references Result for this feature.

## Migration Plan

1. Introduce the Scope/CloseableScope public types and internal ScopeImpl while
   preserving the existing value-level Scope helpers.
2. Add outcome and diagnostic types, the Runtime classifier, and the
   generalized boundary helper.
3. Update Scope closure, child propagation, flattening, and finalizer callback
   invocation.
4. Thread Runtime options, one-shot precedence, root/backend aggregation, and
   build-failure cleanup through layer building, Runtime execution, and
   disposal.
5. Widen `Effect.acquireRelease` release typing and add runtime/type tests.
6. Update existing tests whose expected combined failures change, then update
   README, AGENTS.md, and CODEX_HANDOFF.md with the formal contract.
7. Run `bun run check` and `bun pm pack --dry-run` before review.

Rollback is source-level: remove the change artifacts and revert the
implementation commit. No persisted data or wire-format migration is involved.

## Context

See `proposal.md` for the motivation and scope. Today a `BuiltLayer` owns a root `Scope`, while each `run()` creates an unrelated Scope through `Scope.run()`. The scope context is backed by `AsyncLocalStorage`, finalizers are already idempotent and LIFO, and Layer provider release callbacks are already registered with the root Scope rather than delegated to DI adapters.

The design must preserve those existing lifecycle and `Resource` semantics while making execution ownership explicit and preventing Runtime shutdown from closing root resources before active executions finish.

## Goals / Non-Goals

**Goals:**

- Represent execution lifetimes as children of the Runtime root Scope.
- Provide an explicit context-only operation for an existing Scope, separate from the operation that creates and closes one.
- Ensure parent closure cleans up still-attached children before its own finalizers and always attempts all reachable cleanup.
- Make Runtime disposal reject new work, wait for active work, then release root resources and perform backend cleanup.
- Keep the public Runtime facade small and preserve existing Scope, Layer, and Resource compatibility.

**Non-Goals:**

- No `ManagedRuntime` type, fiber/cancellation model, shutdown timeout, or exit-aware finalizer protocol.
- No `Scope.withChild()` convenience method in this change.
- No changes to `Resource` error precedence or to DI adapter ownership rules.

## Decisions

### Scope owns an explicit child tree

`Scope` will keep a private parent reference and a `Set` of attached children. `fork()` requires an open parent, creates an open child, and registers it immediately. A child detaches from its parent at the end of close, including when cleanup fails, so long-lived runtimes do not retain closed execution scopes.

When closing, a scope snapshots and clears its current children, closes them in reverse registration order, then runs its own finalizers in reverse registration order. Child and finalizer failures are collected and surfaced through the existing scope close error shape after all cleanup has been attempted.

This is preferred over a flat registry because ownership is local, parent shutdown naturally covers unfinished executions, and normal child completion removes its own bookkeeping.

### Separate provisioning from lifecycle ownership

Add `Scope.provide(scope, program)` as a thin `AsyncLocalStorage` boundary that returns the program result and never closes the supplied Scope. Refactor `Scope.run()` to create a Scope, call `provide()`, and retain the current behavior of closing after both successful and failed programs, including aggregation when program execution and cleanup both fail.

Keeping the two operations separate avoids accidentally closing externally owned scopes when Runtime or a caller only wants to establish context. A single `run()` operation that always creates a scope was considered, but would force Runtime to use an unrelated root and would make nested ownership implicit.

### BuiltLayer tracks Runtime executions

Active execution tracking belongs in the existing BuiltLayer implementation rather than in the public Runtime facade. `Runtime` already delegates construction, execution, and disposal to BuiltLayer; keeping state there prevents two lifecycle authorities from diverging.

Each `run()` will synchronously verify the active state, fork a child from the root Scope, and execute the program inside both the Service and Scope contexts. The child closes in a `finally` path before the returned promise settles. The active-execution set will remove promises using success and failure handlers that consume the derived promise, avoiding an unhandled rejection from an unobserved `finally()` chain.

The Runtime state transitions are:

```text
active ── dispose() ──▶ disposing ── all runs settled ──▶ disposed
  │                          │
  └────── new run allowed     └── new run rejected
```

### Disposal is graceful and ordered

`dispose()` is memoized and changes the state to `disposing` before awaiting anything. It waits for the current active execution promises, closes the root Scope, and only then invokes backend cleanup. It records all failures and exposes one stable disposal outcome; repeated calls share the same promise and do not repeat releases.

The explicit active set is preferred over relying only on `rootScope.close()`: closing the root would otherwise close children while their programs are still running. No timeout or cancellation is introduced, so an execution that never settles can keep disposal pending by design.

### Layer resource ownership remains at the root

The provider wrapper continues to acquire Layer resources under the root Scope. Runtime execution children are used only for resources acquired during a run. This preserves the invariant that a cached Layer Service survives between executions and is released only during Runtime disposal.

### Tests are the migration guard

Extend scope tests for fork/detach, child-before-parent ordering, parent cleanup after child failures, and `provide()` non-ownership. Extend Layer/Runtime tests for concurrent child isolation, graceful disposal, rejection of new runs during disposal, and root resource lifetime. Existing Resource and adapter tests remain regression coverage; no Resource implementation change is required.

## Risks / Trade-offs

- **[A never-settling execution blocks graceful disposal]** → This is explicit and documented; cancellation and timeouts remain outside the change.
- **[Calling `dispose()` from inside one of its own active executions can wait on itself]** → Treat disposal as an external shutdown operation for now and document the reentrancy limitation rather than adding execution identity or cancellation machinery.
- **[Child cleanup can produce multiple failures]** → Continue attempting every child and finalizer, aggregate causes with the existing close error contract, and test both ordering and failure retention.
- **[AsyncLocalStorage context may be absent outside a provided scope]** → Preserve the existing `ScopeRuntimeNotConfiguredError` behavior and route both `provide()` and close execution through the same context boundary.
- **[State changes alter shutdown timing for callers]** → Keep `run()` and `dispose()` promise-based, reject only new work after disposal starts, and document that active work is allowed to finish before root cleanup.

## Migration Plan

1. Add child ownership and `provide()` while keeping existing `Scope.run()` call shapes compatible.
2. Add focused scope tests and type tests, then refactor BuiltLayer execution to fork and provide child scopes.
3. Add active execution tracking and ordered graceful disposal, followed by concurrent-runtime and shutdown regression tests.
4. Run the full Bun check suite and update lifecycle documentation/examples if the public usage needs clarification.

Rollback is a source-level revert: no data migration, dependency change, or persistent format change is introduced.

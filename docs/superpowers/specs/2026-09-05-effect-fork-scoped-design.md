# Effect.forkScoped Design

## Goal

Add a small, Scope-owned task primitive for work started inside an existing Runtime execution. `Effect.forkScoped(program)` returns immediately with a handle while preserving the child Program's success, typed failure, and Service requirements.

## Decisions

- The public operation accepts only the nominal `Effect.Program<A, E, R>` and returns `Effect<ScopedTask<A, E>, never, R>`.
- `ScopedTask` exposes only a live `state`, `await()`, `awaitExit()`, and idempotent `interrupt(reason?)`. The handle never exposes Scope or Runtime ownership.
- `await()` returns the exact child `Result` for success or typed failure and rejects the exact defect, interruption reason, or cleanup failure when there is no typed Result to return. `awaitExit()` is the non-throwing observation API and distinguishes success, typed failure, defect, and interruption; child cleanup failures are attached as diagnostic data.
- Each task gets a child Scope and local controller. Its signal links the current Runtime signal and local controller. The task context reuses the current resolver, Runtime executor, context storage, and execution lineage; it does not create a Runtime or a root execution.
- Scope needs an internal pre-finalizer hook so a parent closes supervised tasks before normal child Scope cleanup and parent resource release. The public Scope interface and its child-first/LIFO semantics remain unchanged.
- Runtime inspection exposes active tasks, and RuntimeObserver gets task start/end events with a task ID and explicit parent execution ID. This is the lineage contract for diagnostics; tasks are not emitted as independent execution spans.

## Lifecycle

1. Validate the complete Runtime context and current Scope.
2. Fork the parent Scope, allocate a local controller, link signals, allocate a task ID, and register the task with the Runtime task supervisor.
3. Start the nominal Program asynchronously through `runScoped`, using Runtime outcome classification and the child context.
4. Resolve typed `Result.err` as a failed task, preserve thrown/rejected causes as defects unless interruption won the race, and capture child cleanup diagnostics without creating unhandled rejections.
5. On parent close, abort active tasks, await their settlement, and allow the already-owned child Scope to finish its own cleanup before parent finalizers run.
6. Remove task and signal references after settlement while keeping the immutable handle's settled observation stable.

## Testing contract

Focused runtime tests cover immediate return, one execution, root and request-local Service resolution, parent and Runtime shutdown interruption, idempotent interruption, sibling isolation, typed failure identity, defects, child cleanup failures, already-aborted signals, concurrent task isolation, request Scope ownership, and the simplified outbox loop. Type tests cover nominal Program inputs, `A`/`E`/`R` inference, incomplete Runtime boundaries, variance, and the public declarations.

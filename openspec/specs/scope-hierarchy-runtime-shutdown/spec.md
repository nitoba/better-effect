# scope-hierarchy-runtime-shutdown Specification

## Purpose

Provides explicit parent/child lifetime ownership for contextual scopes and ensures Runtime shutdown waits for active executions before releasing long-lived Layer resources.

## Requirements

### Requirement: Scopes support hierarchical ownership

An open Scope MUST be able to create a child Scope. The child MUST belong to its parent until it is closed, and closing a child MUST detach it so that a later parent close does not close it again.

#### Scenario: An open Scope forks a child

- **WHEN** an open Scope is forked
- **THEN** a new open child Scope is returned and subsequent resources registered in the child are owned by that child

#### Scenario: A closed Scope cannot fork

- **WHEN** `fork()` is called after a Scope has begun closing or has closed
- **THEN** the operation MUST fail with the existing closed-Scope error

#### Scenario: Closing a child detaches it

- **WHEN** a child Scope is closed and its cleanup completes or fails
- **THEN** the child MUST no longer be owned by its parent and a subsequent parent close MUST NOT execute the child finalizers again

### Requirement: Parent closure owns child cleanup

Closing a `CloseableScope` MUST close all children that are still attached before running the parent’s own finalizers. Child scopes and finalizers MUST be processed in reverse registration order, and cleanup MUST continue after individual failures so every reachable finalizer is attempted. The close operation MUST expose one `ScopeCloseError` containing the cleanup causes in their observed order; nested child close errors MUST be flattened into that single cause list.

#### Scenario: Parent closes active children before its own resources

- **WHEN** a parent with active children and its own finalizers is closed with an outcome
- **THEN** child cleanup MUST complete before parent finalizers begin, both child and parent finalizers MUST use LIFO order, and every finalizer MUST receive the parent’s chosen outcome

#### Scenario: One child or finalizer fails

- **WHEN** a child close or a finalizer fails during parent closure
- **THEN** all remaining children and finalizers MUST still be attempted and the close operation MUST reject with one `ScopeCloseError` whose causes include each raw failure without nested `ScopeCloseError` wrappers

#### Scenario: Closing a Scope is idempotent

- **WHEN** `close()` is called more than once, including concurrently
- **THEN** the same close operation MUST be shared and each child/finalizer MUST run at most once

### Requirement: Scope context can be provided independently from Scope creation

The library MUST expose a non-owning `Scope` capability for acquiring resources, registering finalizers, and creating children, plus an owning `CloseableScope` capability that adds `close(outcome?)`. `Scope.make()` and `Scope.fork()` MUST return a `CloseableScope`; `Scope.current()` and the Scope callback supplied to the convenience runner MUST expose only `Scope`, so a running program cannot close its owning execution Scope through the contextual API. Providing an existing Scope MUST never take ownership of its closure. The convenience Scope runner MUST create an owning Scope, provide its non-owning view to the computation, and close it after the computation settles.

#### Scenario: Providing an existing Scope does not close it

- **WHEN** a computation is executed with an explicitly provided Scope
- **THEN** the computation MUST observe that Scope as current and the provider MUST return without closing it or its resources

#### Scenario: Scope runner closes after success

- **WHEN** a computation is executed through the convenience Scope runner and completes successfully
- **THEN** the result MUST be returned and all resources acquired in that Scope MUST be released before the runner resolves

#### Scenario: Generic Scope runner treats returned Results as values

- **WHEN** a computation executed through the convenience Scope runner returns `Result.err(error)` without throwing
- **THEN** the runner MUST treat the returned Result as a successful value and MUST give its finalizers a success outcome

#### Scenario: Scope runner closes after failure

- **WHEN** a computation executed through the convenience Scope runner throws or rejects and one of its finalizers also fails
- **THEN** the runner MUST rethrow the exact computation failure, MUST NOT replace it with an aggregate error, and MUST still attempt every cleanup

#### Scenario: Scope access does not become a Service requirement

- **WHEN** an Effect generator accesses the current Scope through its contextual yieldable and also yields a Service
- **THEN** the inferred Effect requirements MUST include the Service but MUST NOT include Scope

### Requirement: Runtime executions are owned by the Runtime root Scope

Each Runtime execution MUST be registered as active before its user computation can run and MUST use a fresh child `CloseableScope` owned by the Runtime root. The contextual Scope exposed to the program MUST be non-owning, and the execution child MUST close after its computation settles. Resources acquired by Layer providers remain owned by the root Scope and survive between executions. The final result at the execution boundary MUST determine the child outcome: plain values and `Result.ok` are success, `Result.err` is a failure with its error, and thrown or rejected programs are failures with their thrown causes. Intermediate Results MUST NOT change the child outcome. When both the computation and child cleanup fail, the computation failure MUST remain primary and cleanup MUST be reported separately when diagnostics are configured.

#### Scenario: An execution receives an isolated child Scope

- **WHEN** two executions run concurrently on the same Runtime
- **THEN** each execution MUST observe a distinct current Scope, neither contextual Scope MUST expose the owner’s close operation, and closing one execution MUST NOT release resources registered in the other

#### Scenario: Execution cleanup runs on completion

- **WHEN** a Runtime execution completes successfully, returns a Result error, throws, or rejects
- **THEN** its child Scope MUST be closed with the classified final outcome before the execution promise settles

#### Scenario: Execution and cleanup failures are both preserved

- **WHEN** a Runtime program fails and one of its execution-scope finalizers also fails
- **THEN** the execution MUST preserve the original program failure as its external result and MUST preserve the cleanup failure in one aggregated diagnostic when an observer is configured

#### Scenario: Result error and cleanup failure preserve the typed result

- **WHEN** a Runtime program returns a `Result.err` and an execution finalizer fails
- **THEN** the execution MUST return the exact original `Result.err`, MUST NOT reject solely because of cleanup, and MUST report the cleanup diagnostic when an observer is configured

#### Scenario: Exception and cleanup failure preserve the exception

- **WHEN** a Runtime program throws or rejects and an execution finalizer fails
- **THEN** the execution MUST reject with the exact original exception and MUST report the cleanup diagnostic when an observer is configured

#### Scenario: Cleanup failure is primary after program success

- **WHEN** a Runtime program returns a plain value or `Result.ok` and an execution finalizer fails
- **THEN** the execution MUST reject with the aggregated cleanup error and MUST notify the configured cleanup observer

#### Scenario: Recovered intermediate Result error commits the lifetime

- **WHEN** an inner operation produces `Result.err`, the program recovers it, and the complete Runtime execution returns `Result.ok`
- **THEN** the execution child’s finalizers MUST receive a success outcome

#### Scenario: Layer resources outlive executions

- **WHEN** a Layer-scoped Service is acquired during one or more Runtime executions
- **THEN** its release MUST NOT run when an execution ends and MUST run when the Runtime root lifetime is disposed

#### Scenario: Disposal cannot miss a just-started execution

- **WHEN** a program initiates Runtime disposal before yielding control back to its caller
- **THEN** disposal MUST treat that execution as active and MUST NOT close its child Scope until the program has settled

### Requirement: Runtime disposal is graceful and idempotent

Runtime disposal MUST transition the Runtime out of its accepting state before awaiting work, reject new executions, wait for every execution active at that transition, close the root Scope, and then finish backend cleanup. Repeated disposal requests MUST share the same completion and MUST NOT repeat resource release. Failures from executions MUST not prevent root cleanup or backend cleanup from being attempted. A normal long-lived Runtime disposal MUST close the root with a success outcome; a build-failure cleanup MUST close it with the build failure outcome.

#### Scenario: Disposal waits for active executions

- **WHEN** `dispose()` is requested while an execution is still pending
- **THEN** new executions MUST be rejected, the pending execution MUST be allowed to settle and close its child Scope, and only then may root resources be released

#### Scenario: Disposal releases the root lifetime after executions

- **WHEN** all active executions have settled and Runtime disposal continues
- **THEN** root Scope finalizers MUST run with success before backend cleanup completes, and they MUST retain access to the configured Service resolver

#### Scenario: Backend cleanup runs after root cleanup

- **WHEN** root finalizers and backend disposal both produce observable events
- **THEN** every root finalizer event MUST occur before the backend disposal event

#### Scenario: Root and backend cleanup both fail

- **WHEN** root Scope cleanup fails and backend disposal also fails
- **THEN** backend disposal MUST still be attempted and the disposal operation MUST expose both failures in cleanup order without discarding either cause

#### Scenario: Execution failures do not become disposal failures

- **WHEN** an active execution rejects while disposal is waiting for it
- **THEN** disposal MUST still await the execution, attempt root and backend cleanup, and expose the execution failure only through that execution’s result

#### Scenario: Disposal is requested more than once

- **WHEN** `dispose()` is called concurrently or after disposal has completed
- **THEN** callers MUST observe the same disposal outcome and resources/backend cleanup MUST be attempted at most once

#### Scenario: New executions are rejected after disposal begins

- **WHEN** `run()` is called after disposal has transitioned the Runtime to a disposing state
- **THEN** the call MUST fail with the existing `BuiltLayerDisposedError` and MUST NOT invoke the user program

### Requirement: Scope closure carries an explicit outcome

The public `CloseableScope` API MUST expose a two-state `ScopeOutcome` value consisting of success or failure with an unknown cause. `close()` without an argument MUST be equivalent to closing with success. The first close call MUST fix the outcome for that Scope; later close calls MUST return the original close Promise and ignore different outcomes. A parent closing with an outcome MUST pass that outcome to every still-attached child, while an already closed child MUST retain the outcome chosen by its own first close.

#### Scenario: Closing without an outcome means success

- **WHEN** a CloseableScope is closed without an argument
- **THEN** every finalizer MUST receive `{ status: 'success' }`

#### Scenario: The first close determines the outcome

- **WHEN** concurrent callers close a CloseableScope with different outcomes
- **THEN** all callers MUST receive the same close Promise and finalizers MUST observe the outcome from the first close that began

#### Scenario: Parent propagates its outcome to open children

- **WHEN** a parent is closed with a failure outcome while a child remains attached
- **THEN** the child’s finalizers MUST receive that same failure outcome

#### Scenario: A child keeps its prior outcome

- **WHEN** a child has already started closing with one outcome and its parent later closes with another
- **THEN** the child’s finalizers MUST retain the outcome from its own first close

### Requirement: Scope ownership prevents contextual self-closure

The non-owning `Scope` type MUST expose resource acquisition, finalizer registration, and child creation, but MUST NOT expose `close()`. The owning `CloseableScope` type MUST extend those capabilities with `close(outcome?)`. `Scope.current()` MUST return the non-owning type, while `Scope.make()` and `Scope.fork()` MUST return the owning type. This type-level separation MUST prevent a Runtime program from closing its execution Scope through the normal contextual API.

#### Scenario: Current Scope cannot be closed by the program

- **WHEN** a program obtains the Scope through `Scope.current()` or `yield* Scope`
- **THEN** its static type MUST provide acquisition and registration operations but MUST NOT provide `close()`

#### Scenario: Owner-created scopes remain closeable

- **WHEN** a caller creates a Scope with `Scope.make()` or forks one from an existing Scope
- **THEN** the returned type MUST provide `close(outcome?)` and the caller MUST remain responsible for closing it

### Requirement: Cleanup failures have best-effort aggregated diagnostics

`Scope.close()` MUST be observer-free and only produce its normal close result. An execution or Runtime disposal boundary MAY receive an optional `CleanupFailureObserver`. When that boundary’s close operation has one or more cleanup failures, it MUST aggregate all raw causes, including flattened child causes, into one `ScopeCloseError` and invoke the observer once with:

```ts
type CleanupFailureDiagnostic = {
  readonly outcome: ScopeOutcome
  readonly error: ScopeCloseError
}
```

Observer failures MUST be ignored. Diagnostics MUST never change the primary program result: a failed program keeps its original exception or `Result.err`, while a successful program exposes the `ScopeCloseError` as its failure. If no observer is configured, cleanup failure while a program already failed is intentionally suppressed. A parent close MUST NOT produce additional observer calls for child close failures.

#### Scenario: Multiple cleanup failures notify once

- **WHEN** several child or finalizer cleanups fail during one boundary close
- **THEN** the observer MUST be called once and its diagnostic MUST contain one flattened `ScopeCloseError` with all failures in cleanup order

#### Scenario: Direct Scope close does not notify

- **WHEN** a caller closes a CloseableScope directly without going through a boundary with an observer
- **THEN** the Scope MUST only resolve or reject its close Promise and MUST NOT invoke any observer

#### Scenario: Observer failure is isolated

- **WHEN** the cleanup observer itself throws or rejects
- **THEN** the observer failure MUST NOT escape or alter the close, program, or disposal result

#### Scenario: Cleanup diagnostics do not replace a Result error

- **WHEN** a program returns `Result.err`, cleanup fails, and no observer is configured
- **THEN** the exact `Result.err` MUST be returned and the cleanup failure MUST not become a rejected Promise

### Requirement: One-shot Runtime preserves program precedence during shutdown

The static one-shot Runtime runner MUST classify the complete program result, close the execution Scope, close the root Scope with the same final outcome, and attempt backend disposal. Root and backend cleanup MUST both be attempted even when the other cleanup phase fails. A failed program MUST remain the external result; a successful program MUST expose shutdown cleanup failures. When both root and backend cleanup fail, the shutdown failure MUST preserve both causes in cleanup order.

#### Scenario: One-shot Result error survives root cleanup failure

- **WHEN** a one-shot program returns `Result.err` and root Scope cleanup or backend disposal fails
- **THEN** the runner MUST return the exact original `Result.err` and MUST report shutdown cleanup through the configured observer

#### Scenario: One-shot exception survives root cleanup failure

- **WHEN** a one-shot program throws or rejects and root Scope cleanup or backend disposal fails
- **THEN** the runner MUST rethrow the exact original program cause and MUST report shutdown cleanup through the configured observer

#### Scenario: One-shot success exposes shutdown cleanup failure

- **WHEN** a one-shot program returns a plain value or `Result.ok` and root or backend cleanup fails
- **THEN** the runner MUST reject with the shutdown cleanup failure after attempting both cleanup phases

#### Scenario: Root and backend failures are both preserved

- **WHEN** root Scope cleanup fails and backend disposal also fails during a one-shot run
- **THEN** the runner MUST preserve both failures in one shutdown error in root cleanup order followed by backend cleanup order

#### Scenario: One-shot successful values close the root successfully

- **WHEN** a one-shot program returns a plain value or `Result.ok` and cleanup succeeds
- **THEN** root finalizers MUST receive `{ status: 'success' }` before backend disposal

#### Scenario: One-shot Result errors close the root with failure

- **WHEN** a one-shot program returns `Result.err(error)` and cleanup succeeds
- **THEN** root finalizers MUST receive `{ status: 'failure', cause: error }` before backend disposal

#### Scenario: One-shot exceptions close the root with failure

- **WHEN** a one-shot program throws or rejects with `cause`
- **THEN** root finalizers MUST receive `{ status: 'failure', cause }` before backend disposal

### Requirement: Runtime exposes cleanup diagnostics

Runtime construction and layer building MUST accept an optional `CleanupFailureObserver` option with this shape:

```ts
type RuntimeOptions = {
  readonly onCleanupFailure?: CleanupFailureObserver
}

type RuntimeShutdownDiagnostic = {
  readonly outcome: ScopeOutcome
  readonly error: LayerDisposeError
}

type CleanupFailureObserver = (
  diagnostic: CleanupFailureDiagnostic | RuntimeShutdownDiagnostic
) => void | PromiseLike<void>
```

The observer MUST receive diagnostics from execution and root Scope cleanup, but MUST NOT receive one notification per child nested inside a parent close. The static one-shot Runtime runner MUST use the complete program outcome for its root cleanup, while a long-lived Runtime MUST use success for normal disposal. The observer is diagnostic-only and MUST NOT change the Runtime’s program or disposal result.

#### Scenario: A configured observer receives execution cleanup diagnostics

- **WHEN** an execution finalizer fails and Runtime was created with a cleanup observer
- **THEN** the observer MUST receive one diagnostic containing the execution’s classified outcome and aggregated cleanup error

#### Scenario: A configured observer receives root cleanup diagnostics

- **WHEN** root Scope cleanup fails during Runtime disposal or one-shot shutdown
- **THEN** the observer MUST receive one diagnostic containing the root outcome and aggregated root cleanup error

#### Scenario: Long-lived Runtime closes its root with success

- **WHEN** a manually managed Runtime is disposed after its executions settle
- **THEN** root finalizers MUST receive `{ status: 'success' }` regardless of earlier execution outcomes

### Requirement: Build failure closes the partial root with failure

If Layer construction fails after registering one or more providers, the partial root lifetime MUST close with a failure outcome containing the original build cause. All partial root cleanup and backend disposal MUST still be attempted, and the existing build failure contract MUST preserve the original registration cause.

#### Scenario: Build failure supplies its cause to partial root finalizers

- **WHEN** provider registration fails with `buildCause`
- **THEN** partial root finalizers MUST receive `{ status: 'failure', cause: buildCause }` before backend disposal is attempted

#### Scenario: Build cleanup failure does not skip backend disposal

- **WHEN** partial root cleanup fails after a provider registration failure
- **THEN** backend disposal MUST still be attempted and the build failure MUST remain the primary registration failure

#### Scenario: Build cleanup diagnostics are reported

- **WHEN** provider registration fails and partial root or backend cleanup also fails while a cleanup observer is configured
- **THEN** the observer MUST receive one shutdown diagnostic containing the build failure outcome and a `LayerDisposeError`, while the registration failure remains the primary build error

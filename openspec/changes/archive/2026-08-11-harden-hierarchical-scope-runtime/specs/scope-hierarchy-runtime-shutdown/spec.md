## MODIFIED Requirements

### Requirement: Runtime executions are owned by the Runtime root Scope

Each Runtime execution MUST be registered as active before its user computation can run and MUST use a fresh child Scope of the Runtime’s root Scope. The execution child MUST close after its computation settles, while resources acquired by Layer providers remain owned by the root Scope and survive between executions. If both the computation and child cleanup fail, the execution result MUST preserve both failures, with the computation failure retained as the primary failure.

#### Scenario: An execution receives an isolated child Scope

- **WHEN** two executions run concurrently on the same Runtime
- **THEN** each execution MUST observe a distinct current Scope, and closing one execution MUST NOT release resources registered in the other

#### Scenario: Execution cleanup runs on completion

- **WHEN** a Runtime execution completes successfully, throws, or rejects
- **THEN** its child Scope MUST be closed before the execution promise settles

#### Scenario: Execution and cleanup failures are both preserved

- **WHEN** a Runtime program fails and one of its execution-scope finalizers also fails
- **THEN** the execution MUST reject with an error that preserves both causes, retaining the program failure before the cleanup failure

#### Scenario: Layer resources outlive executions

- **WHEN** a Layer-scoped Service is acquired during one or more Runtime executions
- **THEN** its release MUST NOT run when an execution ends and MUST run when the Runtime root lifetime is disposed

#### Scenario: Disposal cannot miss a just-started execution

- **WHEN** a program initiates Runtime disposal before yielding control back to its caller
- **THEN** disposal MUST treat that execution as active and MUST NOT close its child Scope until the program has settled

### Requirement: Runtime disposal is graceful and idempotent

Runtime disposal MUST transition the Runtime out of its accepting state before awaiting work, reject new executions, wait for every execution active at that transition, close the root Scope, and then finish backend cleanup. Repeated disposal requests MUST share the same completion and MUST NOT repeat resource release. Failures from executions MUST not prevent root cleanup or backend cleanup from being attempted.

#### Scenario: Disposal waits for active executions

- **WHEN** `dispose()` is requested while an execution is still pending
- **THEN** new executions MUST be rejected, the pending execution MUST be allowed to settle and close its child Scope, and only then may root resources be released

#### Scenario: Disposal releases the root lifetime after executions

- **WHEN** all active executions have settled and Runtime disposal continues
- **THEN** root Scope finalizers MUST run before backend cleanup completes

#### Scenario: Backend cleanup runs after root cleanup

- **WHEN** root finalizers and backend disposal both produce observable events
- **THEN** every root finalizer event MUST occur before the backend disposal event

#### Scenario: Execution failures do not become disposal failures

- **WHEN** an active execution rejects while disposal is waiting for it
- **THEN** disposal MUST still await the execution, attempt root and backend cleanup, and expose the execution failure only through that execution’s result

#### Scenario: Disposal is requested more than once

- **WHEN** `dispose()` is called concurrently or after disposal has completed
- **THEN** callers MUST observe the same disposal outcome and resources/backend cleanup MUST be attempted at most once

#### Scenario: New executions are rejected after disposal begins

- **WHEN** `run()` is called after disposal has transitioned the Runtime to a disposing state
- **THEN** the call MUST fail with the existing `BuiltLayerDisposedError` and MUST NOT invoke the user program

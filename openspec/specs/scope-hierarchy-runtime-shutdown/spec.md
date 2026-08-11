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

Closing a parent Scope MUST close all children that are still attached before running the parent’s own finalizers. Child scopes and finalizers MUST be processed in reverse registration order, and cleanup MUST continue after individual failures so every reachable finalizer is attempted.

#### Scenario: Parent closes active children before its own resources

- **WHEN** a parent with active children and its own finalizers is closed
- **THEN** child cleanup MUST complete before parent finalizers begin, with both child and parent finalizers using LIFO order

#### Scenario: One child or finalizer fails

- **WHEN** a child close or a finalizer fails during parent closure
- **THEN** all remaining children and finalizers MUST still be attempted and the close operation MUST reject with an error that preserves the cleanup failures

#### Scenario: Closing a Scope is idempotent

- **WHEN** `close()` is called more than once, including concurrently
- **THEN** the same close operation MUST be shared and each child/finalizer MUST run at most once

### Requirement: Scope context can be provided independently from Scope creation

The library MUST expose a way to execute a computation with an existing Scope without taking ownership of its closure. The convenience Scope runner MUST create a Scope, provide it to the computation, and close it after the computation settles, whether the computation succeeds or fails.

#### Scenario: Providing an existing Scope does not close it

- **WHEN** a computation is executed with an explicitly provided Scope
- **THEN** the computation MUST observe that Scope as current and the provider MUST return without closing it or its resources

#### Scenario: Scope runner closes after success

- **WHEN** a computation is executed through the convenience Scope runner and completes successfully
- **THEN** the result MUST be returned and all resources acquired in that Scope MUST be released before the runner resolves

#### Scenario: Scope runner closes after failure

- **WHEN** a computation executed through the convenience Scope runner throws or rejects
- **THEN** the Scope MUST still be closed before the failure is rethrown, preserving both computation and cleanup failures when both occur

#### Scenario: Scope access does not become a Service requirement

- **WHEN** an Effect generator accesses the current Scope through its contextual yieldable and also yields a Service
- **THEN** the inferred Effect requirements MUST include the Service but MUST NOT include Scope

### Requirement: Runtime executions are owned by the Runtime root Scope

Each Runtime execution MUST use a fresh child Scope of the Runtime’s root Scope. The execution child MUST close after its computation settles, while resources acquired by Layer providers remain owned by the root Scope and survive between executions.

#### Scenario: An execution receives an isolated child Scope

- **WHEN** two executions run concurrently on the same Runtime
- **THEN** each execution MUST observe a distinct current Scope, and closing one execution MUST NOT release resources registered in the other

#### Scenario: Execution cleanup runs on completion

- **WHEN** a Runtime execution completes successfully, throws, or rejects
- **THEN** its child Scope MUST be closed before the execution promise settles

#### Scenario: Layer resources outlive executions

- **WHEN** a Layer-scoped Service is acquired during one or more Runtime executions
- **THEN** its release MUST NOT run when an execution ends and MUST run when the Runtime root lifetime is disposed

### Requirement: Runtime disposal is graceful and idempotent

Runtime disposal MUST stop new executions, wait for all executions already in progress, close the root Scope, and then finish backend cleanup. Repeated disposal requests MUST share the same completion and MUST NOT repeat resource release.

#### Scenario: Disposal waits for active executions

- **WHEN** `dispose()` is requested while an execution is still pending
- **THEN** new executions MUST be rejected, the pending execution MUST be allowed to settle and close its child Scope, and only then may root resources be released

#### Scenario: Disposal releases the root lifetime after executions

- **WHEN** all active executions have settled and Runtime disposal continues
- **THEN** root Scope finalizers MUST run before backend cleanup completes

#### Scenario: Disposal is requested more than once

- **WHEN** `dispose()` is called concurrently or after disposal has completed
- **THEN** callers MUST observe the same disposal outcome and resources/backend cleanup MUST be attempted at most once

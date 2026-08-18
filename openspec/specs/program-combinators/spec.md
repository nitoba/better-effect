# program-combinators Specification

## Purpose

Adds lazy collection helpers for concurrent work so Service resolution and
Runtime context installation happen before any Program body begins.

## Requirements

### Requirement: Program collections remain lazy

`Program.all` MUST accept lazy Programs and return a lazy Program. Constructing the collection MUST NOT invoke any input Program, resolve a Service, or create a Scope. Each input Program MUST be invoked at most once when the returned Program is executed.

#### Scenario: Building Program.all does no work

- **WHEN** `Program.all` is constructed from three Programs whose bodies record execution
- **THEN** no body MUST have run before the returned Program is executed

#### Scenario: Runtime context is installed before invocation

- **WHEN** a returned `Program.all` is executed through a Runtime
- **THEN** every started Program MUST observe the Runtime's resolver, Scope, and abort context

### Requirement: Program.all enforces bounded concurrency

`Program.all` MUST accept an optional positive integer `concurrency` limit. At no time MAY more than that number of input Programs be active. Omitting the option MUST preserve an unbounded/default collection mode. Invalid limits MUST be rejected before execution.

#### Scenario: Concurrency three limits active work

- **WHEN** five Programs are collected with `{ concurrency: 3 }`
- **THEN** at most three bodies MUST be active at any instant and the remaining bodies MUST start only as slots become available

#### Scenario: Invalid concurrency is rejected

- **WHEN** `concurrency` is zero, negative, fractional, or non-finite
- **THEN** construction MUST fail with a validation error and MUST not invoke an input Program

### Requirement: Program.all preserves tuple order and channel unions

The collected Program MUST expose a tuple of successful values in input order. Its error channel MUST include errors from every input Program, and its Service requirement channel MUST include requirements from every input Program. A failure MUST follow the same Result error semantics as the existing collection helpers; no successful tuple MAY be returned when collection fails.

#### Scenario: Heterogeneous Programs retain exact positions

- **WHEN** Programs return `User`, `Permissions`, and `Preferences`
- **THEN** the result MUST be `[User, Permissions, Preferences]` in that order and its requirements MUST be the union of all three Programs

#### Scenario: One Program fails

- **WHEN** one collected Program returns an `Err`
- **THEN** the collection MUST return an error compatible with the underlying Result semantics and MUST not report a successful tuple

### Requirement: Program collection does not add cancellation semantics

`Program.all` MUST NOT cancel, dispose, or replace the Runtime's Scope or AbortSignal. Programs already started by the bounded scheduler MAY finish normally, and their existing cleanup MUST remain owned by the enclosing execution.

#### Scenario: In-flight work remains Runtime-owned

- **WHEN** one Program fails while another started Program owns a scoped resource
- **THEN** the resource MUST remain governed by the execution Scope and MUST be released by the normal Runtime boundary

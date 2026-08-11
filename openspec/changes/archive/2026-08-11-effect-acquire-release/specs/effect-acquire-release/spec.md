## Purpose

Provides a small, yieldable acquire-and-release operation for async `Effect.gen` programs while keeping resource ownership and cleanup entirely within the existing contextual Scope lifecycle.

## ADDED Requirements

### Requirement: Effect programs can acquire scoped resources without exposing Scope

The public `Effect` API MUST provide an `acquireRelease` operation that accepts an acquire callback and a resource-specific release callback. When yielded from an async `Effect.gen` program with an active Scope, it MUST return the acquired resource and register exactly one release finalizer in that Scope before yielding the resource to the program.

#### Scenario: A program acquires and releases a resource through Effect

- **WHEN** an async `Effect.gen` program yields `Effect.acquireRelease(acquire, release)` inside an active Scope
- **THEN** the program MUST receive the acquired resource, and the release callback MUST run when the owning Scope closes

#### Scenario: Acquisition is lazy and scoped to the current execution

- **WHEN** the operation is constructed and yielded during a Runtime execution
- **THEN** acquisition MUST occur in that execution’s current Scope and MUST NOT create or close a separate Scope

#### Scenario: Scope remains an implementation context rather than an Effect requirement

- **WHEN** an Effect program uses only `Effect.acquireRelease` and no Service tokens
- **THEN** its inferred `EffectRequirements` MUST be `never`

### Requirement: Acquisition failures use the Effect Result error channel

If acquisition throws or rejects, `Effect.acquireRelease` MUST not register a release finalizer and MUST expose the failure as an `Err` compatible with the Effect Result error channel. Unexpected thrown or rejected causes MUST use `better-result`’s existing `UnhandledException` normalization.

#### Scenario: Acquisition rejects

- **WHEN** the acquire callback rejects before returning a resource
- **THEN** the Effect result MUST be an error containing `UnhandledException`, and the release callback MUST NOT run

#### Scenario: Acquisition throws synchronously

- **WHEN** the acquire callback throws before returning a resource
- **THEN** the Effect result MUST be an error containing `UnhandledException`, and the release callback MUST NOT run

#### Scenario: No Scope is available

- **WHEN** an acquire-and-release operation is yielded without a configured current Scope
- **THEN** the operation MUST fail through the existing Scope-context error behavior and MUST NOT acquire or register a resource

### Requirement: Release remains owned by Scope cleanup

The release callback MUST run after the owning Scope’s computation settles, including successful Result completion, Result error completion, thrown exceptions, and rejected promises. Release failures MUST remain Scope cleanup failures and MUST be surfaced by the existing Scope/Runtime close behavior rather than being treated as outcome-aware Effect errors.

#### Scenario: A Result error still releases the resource

- **WHEN** an Effect program acquires a resource and later yields an `Err`
- **THEN** the release callback MUST still run exactly once when the owning Scope closes

#### Scenario: A thrown or rejected program still releases the resource

- **WHEN** an Effect program acquires a resource and then throws or rejects
- **THEN** the release callback MUST still run exactly once before the owning Runtime execution settles

#### Scenario: Release failure is reported by Scope cleanup

- **WHEN** the release callback throws or rejects during Scope closure
- **THEN** the owning Scope/Runtime operation MUST report the existing cleanup failure while preserving the program failure precedence defined by Scope lifecycle semantics

### Requirement: Effect acquireRelease has a typed success value

The yieldable operation MUST infer its yielded success value as the acquired resource type and MUST preserve `UnhandledException` in the Effect error type without adding any Scope requirement.

#### Scenario: Type inference exposes the resource type

- **WHEN** a program yields an acquire-and-release operation whose acquire callback returns `Connection`
- **THEN** the yielded variable MUST be inferred as `Connection`, `EffectSuccess` MUST include `Connection`, and `EffectRequirements` MUST remain `never` unless other Services are yielded

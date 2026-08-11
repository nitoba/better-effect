## Purpose

Provides an Effect-native way to register already-acquired JavaScript disposable objects in the current Scope without exposing Scope in ordinary generator programs.

## ADDED Requirements

### Requirement: Effect programs can register disposable objects without exposing Scope

The public `Effect` API MUST provide `Effect.add(resource)`. When yielded inside an async `Effect.gen` with an active Scope, it MUST register exactly one finalizer for that already-acquired resource in the current Scope and yield the exact same resource object back to the program. It MUST NOT create, acquire, or close a separate resource or Scope.

#### Scenario: Synchronous disposable is registered

- **WHEN** an Effect program yields `Effect.add(resource)` for an object implementing `Symbol.dispose`
- **THEN** the yielded value MUST be the same object and `Symbol.dispose` MUST run once when the owning Scope closes

#### Scenario: Asynchronous disposable is registered

- **WHEN** an Effect program yields `Effect.add(resource)` for an object implementing `Symbol.asyncDispose`
- **THEN** the owning Scope MUST await that asynchronous disposer during cleanup

#### Scenario: Scope remains contextual infrastructure

- **WHEN** an Effect program uses `Effect.add` without yielding any Service token
- **THEN** its inferred `EffectRequirements` MUST be `never`

### Requirement: Effect.add preserves Scope cleanup semantics

Disposable cleanup registered by `Effect.add` MUST remain Scope cleanup. It MUST run for successful completion, final `Result.err`, thrown exceptions, and rejected programs, and disposal failures MUST follow the existing Scope/Runtime aggregation, diagnostic, and failure-precedence rules rather than becoming an Effect error after successful registration.

#### Scenario: Result error still disposes the resource

- **WHEN** an Effect program registers a resource and later returns `Result.err`
- **THEN** the resource MUST be disposed once when the execution Scope closes with failure

#### Scenario: Thrown program still disposes the resource

- **WHEN** an Effect program registers a resource and later throws or rejects
- **THEN** the resource MUST be disposed before the Runtime execution settles and the original program cause MUST retain precedence over disposal failure

#### Scenario: Disposal failure is reported as cleanup

- **WHEN** a registered disposer throws or rejects during Scope closure
- **THEN** the failure MUST participate in the owning boundary's existing cleanup aggregation and diagnostics

### Requirement: Registration failures use existing Effect error behavior

Failures produced while adding the resource to an available Scope MUST be normalized through `better-result` as `UnhandledException` in the Effect error channel. If no Scope is configured, `Effect.add` MUST preserve the existing missing-Scope failure behavior used by `Effect.acquireRelease`.

#### Scenario: Registration races with a closing Scope

- **WHEN** `Effect.add` attempts to register a disposable after its current Scope has begun closing
- **THEN** the resource MUST be disposed immediately, MUST NOT remain registered, and the registration failure MUST enter the Effect error channel

#### Scenario: Immediate disposal also fails

- **WHEN** registration fails because the Scope is closing and immediate disposal also fails
- **THEN** both failures MUST remain preserved by the existing Scope registration-failure aggregation and enter the Effect error channel

#### Scenario: No Scope is available

- **WHEN** `Effect.add` is yielded without a configured current Scope
- **THEN** the operation MUST fail through the existing Scope-context error behavior and MUST NOT claim ownership of the resource

### Requirement: Effect.add retains precise public types

`Effect.add` MUST accept a `DisposableResource`, yield the exact input subtype, include `UnhandledException` in its Effect error type, and add no Service requirement.

#### Scenario: Concrete subtype is preserved

- **WHEN** a concrete TemporaryFile subtype is passed to `Effect.add`
- **THEN** the yielded value and `EffectSuccess` MUST retain TemporaryFile rather than widen to `DisposableResource`

#### Scenario: Error and requirement metadata are inferred

- **WHEN** an Effect program only yields `Effect.add(resource)`
- **THEN** `EffectError` MUST be `UnhandledException` and `EffectRequirements` MUST be `never`

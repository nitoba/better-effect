## Purpose

Ensures every typed Runtime execution can request only Services supplied by its Layer, turning existing Effect requirement metadata into compile-time environment validation.

## ADDED Requirements

### Requirement: Runtime handles preserve their provided Services

A `Runtime` created from a complete Layer MUST retain the Layer's provided Service-token union in its public type. A `BuiltLayer` returned by `buildLayer()` MUST retain the same union. Layer merge and override semantics MUST be reflected by the retained type without changing runtime behavior.

#### Scenario: Runtime.make infers the Layer environment

- **WHEN** `Runtime.make()` receives a complete Layer that provides Database and Logger
- **THEN** the returned Runtime type MUST retain exactly Database and Logger as its provided Services

#### Scenario: buildLayer preserves the same environment

- **WHEN** `buildLayer()` receives that complete Layer
- **THEN** the returned BuiltLayer type MUST retain the same provided-Service union as `Runtime.make()`

#### Scenario: Overrides determine the retained environment

- **WHEN** a Runtime is built from a Layer whose providers were replaced with `Layer.override()`
- **THEN** the Runtime type MUST reflect the final overridden Layer specification rather than obsolete provider specifications

### Requirement: Managed executions validate Effect requirements

Instance `run()` on both `Runtime` and `BuiltLayer` MUST accept an Effect program only when every Service in its final `EffectRequirements` is supplied by the handle's provided-Service union. Requirement satisfaction MUST use the same Service-token compatibility semantics as complete-Layer validation. The validation MUST inspect the complete returned Effect type, including requirements composed from nested Effect results.

#### Scenario: All program requirements are available

- **WHEN** a Runtime provides Database and Logger and a program requires both Services
- **THEN** `runtime.run(program)` MUST compile and preserve the program's original result type

#### Scenario: One program requirement is missing

- **WHEN** a Runtime provides Database and a program requires Database and Logger
- **THEN** the `runtime.run(program)` call MUST be rejected at compile time and its diagnostic contract MUST identify Logger as missing

#### Scenario: Multiple program requirements are missing

- **WHEN** a program requires several Services absent from the Runtime
- **THEN** the compile-time missing-Service contract MUST contain the exact union of absent Service tokens

#### Scenario: Returned Effect requirements remain validated

- **WHEN** an Effect program directly requires one Service and returns a composed Effect result requiring another
- **THEN** the Runtime MUST validate both requirements before accepting the execution

#### Scenario: BuiltLayer enforces the same execution contract

- **WHEN** a caller uses `buildLayer()` directly and runs an Effect program requiring an unavailable Service
- **THEN** `built.run(program)` MUST be rejected by the same compile-time contract as `Runtime.run()`

### Requirement: One-shot Runtime execution validates its Layer

Static `Runtime.run(layer, backend, program)` MUST validate the program's final Effect requirements against the Services provided by the supplied complete Layer. Its accepted program result and error types MUST remain unchanged.

#### Scenario: One-shot execution has a complete environment

- **WHEN** every Service required by a one-shot program is provided by its Layer
- **THEN** static `Runtime.run()` MUST compile and return the same awaited program type as before

#### Scenario: One-shot execution is missing a Service

- **WHEN** a one-shot program requires a Service absent from its Layer
- **THEN** static `Runtime.run()` MUST be rejected at compile time with that Service identified by the missing-Service contract

### Requirement: Requirement-free programs remain supported

Programs whose inferred `EffectRequirements` are `never` MUST remain accepted by any Runtime or BuiltLayer. This includes callbacks returning plain values, ordinary `better-result` Results, Scope-only Effects, and Effects that use `Effect.acquireRelease` without yielding Services. Runtime and BuiltLayer annotations without an explicit provided-Service parameter MUST remain source-compatible as intentionally environment-erased types.

#### Scenario: Plain program runs in any environment

- **WHEN** a program returns a plain value or an ordinary Result without Effect requirement metadata
- **THEN** any Runtime or BuiltLayer MUST accept it without introducing a Service requirement

#### Scenario: Scope-only Effect runs in any environment

- **WHEN** an Effect uses Scope or `Effect.acquireRelease` but yields no Service token
- **THEN** its execution MUST remain accepted because its Service requirements are `never`

#### Scenario: Existing unparameterized Runtime annotation remains valid

- **WHEN** existing code uses `Runtime` or `BuiltLayer` as a type annotation without a generic argument
- **THEN** that annotation MUST continue to compile as an explicitly erased environment and MUST NOT force an immediate source migration

### Requirement: Missing execution Services have readable diagnostics

The compile-time constraint used by execution APIs MUST expose a stable named marker whose value is the exact missing Service-token union. The marker MUST be absent when all requirements are satisfied and MUST NOT alter emitted JavaScript or runtime execution.

#### Scenario: Diagnostic names the missing-Service set

- **WHEN** an execution is rejected because its Runtime lacks required Services
- **THEN** TypeScript's expected parameter contract MUST include `__betterEffectMissingRuntimeServices` with the exact missing-token union

#### Scenario: Complete execution has no marker

- **WHEN** the Runtime provides every required Service
- **THEN** no missing-runtime-Service marker MUST be required and the original program callback type MUST remain assignable

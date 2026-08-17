# typed-runtime-execution-requirements Specification

## Purpose

Ensures typed Runtime boundaries retain Layer-provided Service instance environments and reject unavailable Effect instance requirements with named diagnostics.

## Requirements

### Requirement: Runtime handles preserve provided instance environments

A Runtime or built Layer handle created from a complete Layer MUST retain the exact `Layer.Provided<L>` instance union. Merge and compatible override semantics MUST be reflected without changing runtime registration or resolution.

#### Scenario: Runtime.make infers the Layer environment

- **WHEN** AppLive provides Database and Logger
- **THEN** `Runtime.make(AppLive, backend)` MUST return `Runtime<Database | Logger>`

#### Scenario: Runtime.For names the same environment

- **WHEN** a consumer writes `Runtime.For<typeof AppLive>`
- **THEN** it MUST equal `Runtime<Database | Logger>`

#### Scenario: Built Layer preserves the same environment

- **WHEN** a RuntimeHandle is built from AppLive
- **THEN** it MUST retain Database | Logger as its provided instance union

#### Scenario: Override determines the retained environment

- **WHEN** a compatible override replaces a same-tag provider
- **THEN** the Runtime environment MUST reflect the winning provided instance specification

### Requirement: Managed executions validate Effect instance requirements

Runtime and built-handle `run` methods MUST accept a program only when every concrete instance in its final `Effect.Requirements` is supplied by the provided environment under literal-tag and bidirectional-contract compatibility. The awaited program type MUST be preserved.

#### Scenario: All requirements are available

- **WHEN** `Runtime<Database | Logger>` runs `Effect<A, E, Database | Logger>`
- **THEN** the call MUST compile and preserve the awaited Effect result

#### Scenario: One requirement is missing

- **WHEN** `Runtime<Database>` runs an Effect requiring Database | Logger
- **THEN** TypeScript MUST reject the callback with `MissingDependencies<Logger>`

#### Scenario: Multiple requirements are missing

- **WHEN** `Runtime<Database>` runs an Effect requiring Logger | Cache
- **THEN** the diagnostic MUST be `MissingDependencies<Logger | Cache>`

#### Scenario: Different-tag same-shape Service is rejected

- **WHEN** a Runtime provides ReplicaDatabase while the program requires PrimaryDatabase
- **THEN** execution MUST be rejected despite structural similarity

#### Scenario: Returned requirements remain validated

- **WHEN** a program directly requires Database and returns an Effect requiring Logger
- **THEN** the Runtime MUST validate both instances

### Requirement: One-shot Runtime validates Layer and program

`Runtime.run(layer, backend, program)` MUST validate Layer completeness and the program's final instance requirements while preserving the original awaited result type and lifecycle semantics.

#### Scenario: Complete one-shot execution compiles

- **WHEN** the Layer supplies every required instance
- **THEN** the one-shot call MUST compile and preserve the program type

#### Scenario: Program requirement is unavailable

- **WHEN** the Layer omits a required Logger
- **THEN** the program callback constraint MUST include `MissingDependencies<Logger>`

#### Scenario: Layer itself is incomplete

- **WHEN** a Layer provider requires Database but no Database provider exists
- **THEN** the Layer parameter constraint MUST include `MissingDependencies<Database>`

### Requirement: Erased and generic execution boundaries are deliberate

Unparameterized `Runtime`, `Runtime<any>`, `Runtime<Service.Any>`, `Effect.Any`, and `Effect<A, E, any>` MUST remain explicit unchecked boundaries. A concrete generic relationship MUST be accepted only when proven.

#### Scenario: Erased Runtime accepts a concrete program

- **WHEN** an unparameterized Runtime, Runtime<any>, or Runtime<Service.Any> runs a concrete Effect
- **THEN** execution MUST compile as an intentional escape hatch

#### Scenario: Erased Effect runs in an empty Runtime

- **WHEN** `Effect.Any` or `Effect<A, E, any>` is passed to `Runtime<never>`
- **THEN** execution MUST compile

#### Scenario: Same generic environment runs

- **WHEN** `Runtime<R>` runs `Effect<A, E, R>` for `R extends Service.Any`
- **THEN** execution MUST compile

#### Scenario: Unrelated generic environment is rejected

- **WHEN** `Runtime<Database>` receives `Effect<A, E, R>` for unrelated `R extends Service.Any`
- **THEN** execution MUST remain rejected

### Requirement: Requirement-free programs remain supported

Programs with `Effect.Requirements` equal to `never` MUST run in every Runtime. This includes plain values, ordinary Results, Scope-only Effects, `Effect.acquireRelease`, and `Effect.add` programs that yield no Service constructor.

#### Scenario: Plain and Result programs run

- **WHEN** a callback returns a plain value or ordinary Result
- **THEN** `Runtime<never>` MUST accept it

#### Scenario: Scope and resource programs run

- **WHEN** an Effect uses Scope, acquireRelease, or add without a Service dependency
- **THEN** its requirements MUST remain never and execution MUST compile

### Requirement: MissingDependencies is package-private and type-only

The named `MissingDependencies<Missing>` helper MUST remain absent from package barrels while remaining nameable in built declaration diagnostics. It and all identity/requirement markers MUST emit no JavaScript.

#### Scenario: Built diagnostic retains the name

- **WHEN** current TypeScript or TypeScript 5.7.2 rejects a missing Runtime or Layer dependency
- **THEN** compiler output MUST include the precise `MissingDependencies<...>` instance union

#### Scenario: Complete execution has no diagnostic

- **WHEN** all concrete requirements are supplied
- **THEN** the original program callback type MUST remain assignable without a missing-dependency intersection

#### Scenario: Runtime behavior remains constructor based

- **WHEN** a yielded Service is resolved
- **THEN** the backend MUST receive its constructor token and generated JavaScript MUST contain no phantom metadata

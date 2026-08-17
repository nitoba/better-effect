# typed-runtime-execution-requirements Specification

## Purpose

Ensures typed Runtime boundaries retain Layer-provided Service instance
environments and reject unavailable Effect requirements with named diagnostics.

## Requirements

### Requirement: Runtime values retain Layer.Provided environments

A Runtime or RuntimeHandle created from a complete Layer MUST retain the exact `Layer.Provided<L>` instance union. Merge and compatible override semantics MUST be reflected without changing runtime registration or resolution.

#### Scenario: Runtime.make infers the Layer environment

- **WHEN** AppLive provides Database and Logger
- **THEN** `Runtime.make(AppLive, backend)` MUST return `Runtime<Database | Logger>`

#### Scenario: Runtime.For names the same environment

- **WHEN** a consumer writes `Runtime.For<typeof AppLive>`
- **THEN** it MUST equal `Runtime<Layer.Provided<typeof AppLive>>`

#### Scenario: RuntimeHandle preserves the same environment

- **WHEN** a RuntimeHandle is built from AppLive
- **THEN** it MUST retain the same `Layer.Provided` union

### Requirement: Typed executions validate Effect requirements

Runtime and RuntimeHandle `run` methods MUST accept a program only when every concrete instance in its final `Effect.Requirements` is supplied by the provided environment under literal-tag and bidirectional-contract compatibility. The awaited program type MUST be preserved.

#### Scenario: One requirement is missing

- **WHEN** `Runtime<Database>` runs an Effect requiring Database | Logger
- **THEN** TypeScript MUST reject the callback with `MissingDependencies<Logger>`

#### Scenario: Multiple requirements are missing

- **WHEN** `Runtime<Database>` runs an Effect requiring Logger | Cache
- **THEN** the diagnostic MUST be `MissingDependencies<Logger | Cache>`

#### Scenario: Different-tag same-shape Service is rejected

- **WHEN** a Runtime provides ReplicaDatabase while a program requires PrimaryDatabase
- **THEN** execution MUST be rejected despite structural similarity

#### Scenario: Returned requirements remain validated

- **WHEN** a program directly requires Database and returns an Effect requiring Logger
- **THEN** the Runtime MUST validate both instances

### Requirement: Complete Layer boundaries are enforced by Runtime

Managed Runtime creation, one-shot `Runtime.run`, and `createRuntimeHandle` MUST validate the original Layer input through `Layer.Complete` semantics. The final external requirement channel is `Layer.Required<L>`.

#### Scenario: Layer itself is incomplete

- **WHEN** a Layer provider requires Database but no Database provider exists
- **THEN** the Layer parameter constraint MUST include `MissingDependencies<Database>`

#### Scenario: Complete one-shot execution compiles

- **WHEN** the Layer supplies every required instance and the program's requirements are available
- **THEN** the one-shot call MUST compile and preserve the awaited result type

### Requirement: Runtime input classification rejects unsafe Layer shapes

Concrete Layer unions MUST be rejected by Runtime.make, one-shot Runtime.run, and createRuntimeHandle before provided-environment extraction. Partial-`any` shapes, bare Layers, one-argument Layers, and widened `Service.Any` channels MUST remain typed/incomplete rather than being mistaken for unchecked Layer erasure. Exact `Layer.Any`, `Layer<any, any>`, and `Layer<never, any>` remain explicit unchecked exceptions.

#### Scenario: Concrete union is not flattened

- **WHEN** a runtime receives `Layer<Database, never> | Layer<Logger, never>`
- **THEN** the call MUST be rejected instead of producing `Runtime<Database | Logger>`

#### Scenario: Exact sentinel is accepted

- **WHEN** Runtime receives exact `Layer.Any` or an exact unchecked arm
- **THEN** the call MUST be accepted as an explicit unchecked boundary

#### Scenario: Partial any is rejected

- **WHEN** Runtime receives `Layer<Database, any>`, `Layer<any, never>`, or a cross-partial union
- **THEN** TypeScript MUST reject the original argument without inference widening

### Requirement: Erased and generic execution boundaries remain deliberate

Unparameterized Runtime, `Runtime<any>`, `Runtime<Service.Any>`, `Effect.Any`, and `Effect<A, E, any>` MUST remain explicit unchecked execution boundaries. A concrete generic relationship MUST be accepted only when proven.

#### Scenario: Erased Runtime accepts a concrete program

- **WHEN** an unparameterized Runtime, Runtime<any>, or Runtime<Service.Any> runs a concrete Effect
- **THEN** execution MUST compile as an intentional escape hatch

#### Scenario: Same generic environment runs

- **WHEN** `Runtime<R>` runs `Effect<A, E, R>` for `R extends Service.Any`
- **THEN** execution MUST compile

#### Scenario: Unrelated generic environment is rejected

- **WHEN** `Runtime<Database>` receives `Effect<A, E, R>` for unrelated `R extends Service.Any`
- **THEN** execution MUST remain rejected

### Requirement: Requirement-free programs remain supported

Programs with `Effect.Requirements` equal to `never` MUST run in every Runtime. This includes plain values, ordinary Results, Scope-only Effects, `Effect.acquireRelease`, and `Effect.add` programs that yield no Service constructor.

### Requirement: MissingDependencies is package-private and type-only

The named `MissingDependencies<Missing>` helper MUST remain absent from package barrels while remaining nameable in built declaration diagnostics. It and all identity, requirement and provenance markers MUST emit no JavaScript.

#### Scenario: Built diagnostic retains the name

- **WHEN** current TypeScript or TypeScript 5.7.2 rejects a missing Runtime or Layer dependency
- **THEN** compiler output MUST include the precise `MissingDependencies<...>` instance union

### Requirement: Runtime behavior remains constructor based

- **WHEN** a program evaluates `yield* Database`
- **THEN** the backend MUST receive the Database constructor and generated JavaScript MUST contain no phantom metadata

## MODIFIED Requirements

### Requirement: Runtime handles preserve their provided Services

A `Runtime` created from a complete Layer MUST retain the Layer's exact
provided tagged Service-constructor union in its public type. A built Layer
handle MUST retain the same union. Layer merge and compatible override
semantics MUST be reflected by the retained type without changing runtime
behavior.

#### Scenario: Runtime.make infers the Layer environment

- **WHEN** `Runtime.make()` receives a complete Layer that provides Database and
  Logger
- **THEN** the returned Runtime type MUST retain exactly `typeof Database |
typeof Logger` as its provided Services

#### Scenario: Built Layer preserves the same environment

- **WHEN** a built Layer handle receives that complete Layer
- **THEN** the handle type MUST retain the same exact provided-Service union as
  `Runtime.make()`

#### Scenario: buildLayer preserves the same environment

- **WHEN** `buildLayer()` receives a complete Layer that provides Database and
  Logger
- **THEN** the returned BuiltLayer type MUST retain exactly `typeof Database |
typeof Logger` as its provided Services

#### Scenario: Overrides determine the retained environment

- **WHEN** a Runtime is built from a Layer whose provider is replaced by a
  compatible `Layer.override()`
- **THEN** the Runtime type MUST reflect the final overridden Layer
  specification rather than obsolete provider specifications

### Requirement: Managed executions validate Effect requirements

Instance `run()` on Runtime and built Layer handles MUST accept an Effect
program only when every exact tag-aware contract in its final
`EffectRequirements` is supplied by the handle's provided-Service union under
the tagged compatibility rules. Different tags MUST never satisfy one another, even for identical
contracts. The validation MUST inspect the complete returned Effect type,
including requirements composed from nested Effect results.

#### Scenario: All program requirements are available

- **WHEN** a Runtime provides Database and Logger and a program requires both
  Services
- **THEN** `runtime.run(program)` MUST compile and preserve the program's
  original result type

#### Scenario: One program requirement is missing

- **WHEN** a Runtime provides Database and a program requires Database and
  Logger
- **THEN** the `runtime.run(program)` call MUST be rejected at compile time and
  its diagnostic contract MUST identify `ServiceToken<'Logger', Logger>` as
  missing

#### Scenario: Different-tag compatible Service is rejected

- **WHEN** a Runtime provides ReplicaDatabase and a program requires
  PrimaryDatabase with an identical instance shape but a different tag
- **THEN** the execution MUST be rejected at compile time

#### Scenario: Multiple program requirements are missing

- **WHEN** a program requires several Services absent from the Runtime
- **THEN** the compile-time missing-Service contract MUST contain the exact
  union of absent tagged contracts

#### Scenario: Returned Effect requirements remain validated

- **WHEN** an Effect program directly requires one Service and returns a
  composed Effect result requiring another
- **THEN** the Runtime MUST validate both requirements before accepting the
  execution

#### Scenario: Built Layer enforces the same execution contract

- **WHEN** a caller uses a built Layer handle directly and runs an Effect
  program requiring an unavailable Service
- **THEN** the handle's `run(program)` MUST be rejected by the same compile-time
  contract as `Runtime.run()`

#### Scenario: BuiltLayer enforces the same execution contract

- **WHEN** a caller uses `BuiltLayer.run()` with an Effect program requiring an
  unavailable Service
- **THEN** the call MUST be rejected by the same compile-time contract as
  `Runtime.run()`

### Requirement: One-shot Runtime execution validates its Layer

Static `Runtime.run(layer, backend, program)` MUST validate the program's final
Effect requirements against the exact tagged Services provided by the supplied
complete Layer. Its accepted program result and error types MUST remain
unchanged.

#### Scenario: One-shot execution has a complete environment

- **WHEN** every Service required by a one-shot program is provided by its
  Layer under the tagged compatibility rules
- **THEN** static `Runtime.run()` MUST compile and return the same awaited
  program type as before

#### Scenario: One-shot execution is missing a Service

- **WHEN** a one-shot program requires a Service absent from its Layer, including
  a same-shape Service with a different tag
- **THEN** static `Runtime.run()` MUST be rejected at compile time with that
  exact Service identified by the missing-Service contract

### Requirement: Missing execution Services have readable diagnostics

The compile-time constraint used by execution APIs MUST expose a stable named
marker whose value is the exact missing tagged Service-contract union. The
marker MUST be absent when all requirements are satisfied and MUST NOT alter
emitted JavaScript or runtime execution.

#### Scenario: Diagnostic names the missing-Service set

- **WHEN** an execution is rejected because its Runtime lacks required Services
- **THEN** TypeScript's expected parameter contract MUST include
  `__betterEffectMissingRuntimeServices` with the exact missing-token union and
  a readable `__betterEffectMissingRuntimeService__<Tag>` member for each
  missing Service tag

#### Scenario: Complete execution has no marker

- **WHEN** the Runtime provides every requirement under the tagged compatibility
  rules
- **THEN** no missing-runtime-Service marker MUST be required and the original
  program callback type MUST remain assignable

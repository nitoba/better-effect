## MODIFIED Requirements

### Requirement: Typed executions validate Effect requirements

Runtime and RuntimeHandle `run` methods MUST accept a program only when every concrete instance in its final `Effect.Requirements` is supplied by the provided environment under literal-tag and bidirectional-contract compatibility. The awaited program type MUST be preserved. The same validation MUST apply to the final requirement union produced by `Effect.all`, `Effect.zip`, and lazy `Program.all`.

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

#### Scenario: Program.all validates its complete requirement union

- **WHEN** a Runtime with Database but without Cache runs `Program.all` over a Database Program and a Cache Program
- **THEN** the call MUST be rejected with `MissingDependencies<Cache>` before execution begins

#### Scenario: Effect collections validate all inputs

- **WHEN** `Effect.zip` combines a Database Effect and a Cache Effect at a typed Runtime boundary
- **THEN** the boundary MUST require both Services even if the first Effect would fail at runtime


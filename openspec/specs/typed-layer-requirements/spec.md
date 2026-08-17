# typed-layer-requirements Specification

## Purpose

Defines instance-facing Effect and Layer dependency metadata, exact constructor retention for providers, and readable compile-time completeness diagnostics without changing Result or Layer runtime behavior.

## Requirements

### Requirement: Effects use tagged Service instance requirements

The canonical public program type MUST be `Effect<A, E, R extends Service.Any = never>`, where `R` is a union of tagged Service instances. The type MUST remain a type-only facade over `better-result` and MUST add no runtime Effect representation.

#### Scenario: Direct and returned requirements are combined

- **WHEN** a generator yields Database and returns an Effect requiring Logger
- **THEN** the result MUST be `Effect<A, E, Database | Logger>`

#### Scenario: Ordinary Results add no requirements

- **WHEN** a generator returns a plain `better-result` Result and yields no Service
- **THEN** `Effect.Requirements` MUST be `never`

#### Scenario: Promise-wrapped requirements remain precise

- **WHEN** requirement extraction receives a Promise of an Effect
- **THEN** it MUST return the same instance union as the awaited Effect

### Requirement: Layer metadata exposes instances and retains exact tokens

Each provider specification MUST carry a provided instance, required instance union, and exact registering constructor. Public `Layer.Provided`, `Layer.Required`, and `Layer.Missing` MUST expose only instance unions; registration and override internals MUST retain the exact constructor channel.

#### Scenario: Layer creation infers all channels

- **WHEN** `Layer.make(Database)` is declared
- **THEN** its specification MUST provide `Database`, include `Service.Requirements<Database>`, and retain `typeof Database` as its exact token

#### Scenario: Public projections use instances

- **WHEN** AppLive provides Database and Logger
- **THEN** `Layer.Provided<typeof AppLive>` MUST be `Database | Logger`

#### Scenario: Structural providers remain accepted

- **WHEN** a Layer provider returns `Service.Contract<Database>` without an identity marker
- **THEN** the Layer MUST accept it and expose `Database` as provided

### Requirement: Missing Layer requirements are precise and named

A requirement is supplied only by the same literal tag with a bidirectionally compatible marker-free contract. `Layer.Missing<L>` MUST be the exact absent instance union. A complete-Layer boundary MUST intersect incomplete Layers with package-private `MissingDependencies<Missing>`.

#### Scenario: Multiple missing Services are visible

- **WHEN** a Layer requires Database and PasswordHasher but provides neither
- **THEN** `Layer.Missing<L>` MUST be `Database | PasswordHasher`

#### Scenario: Compiler diagnostic is readable

- **WHEN** that Layer crosses a complete-Layer boundary
- **THEN** the expected contract MUST contain `MissingDependencies<Database | PasswordHasher>`

#### Scenario: Same-shape different tag remains missing

- **WHEN** a Layer requires PrimaryDatabase and provides only same-shaped ReplicaDatabase
- **THEN** `Layer.Missing<L>` MUST contain PrimaryDatabase

#### Scenario: Complete Layer has no missing diagnostic

- **WHEN** every concrete requirement is supplied
- **THEN** `Layer.Missing<L>` MUST be `never` and no `MissingDependencies` intersection is required

### Requirement: Erasure sentinels are explicit

`any` and widened `Service.Any` on either side of completeness matching MUST be unchecked erasure sentinels. Concrete generic relationships MUST remain conditional rather than being erased accidentally.

#### Scenario: Erased environments do not report missing Services

- **WHEN** either the required or provided set is `any` or `Service.Any`
- **THEN** missing-Service inference MUST be `never`

#### Scenario: Same generic environment is accepted

- **WHEN** both required and provided types are the same `R extends Service.Any`
- **THEN** matching MUST accept the proven relationship

#### Scenario: Unrelated generic remains unproven

- **WHEN** a concrete Database environment is compared with unrelated `R extends Service.Any`
- **THEN** the boundary MUST not assume R is provided

### Requirement: Overrides replace complete provider specifications

A compatible same-tag override MUST remove the previous specification and retain the complete winning specification, including its exact constructor and requirements. Compatibility MUST compare provided instance tags and `Service.Contract` shapes only. Incompatible collisions MUST retain the replacement constructor for diagnostics.

#### Scenario: Replacement removes obsolete requirements

- **WHEN** a compatible replacement no longer needs a base provider's acquisition dependency
- **THEN** the obsolete requirement MUST disappear

#### Scenario: Replacement requirements remain tracked

- **WHEN** the replacement requires another Service
- **THEN** that instance requirement MUST remain until provided

#### Scenario: Constructor differences do not collide

- **WHEN** compatible same-tag constructors differ only in parameters, statics, or names
- **THEN** override MUST succeed and retain the replacement constructor

#### Scenario: Last compatible override wins

- **WHEN** multiple compatible overrides target one tag
- **THEN** the final specification MUST be the last override in argument order

### Requirement: Generator providers preserve instance requirements

`Layer.gen` and `Layer.scopedGen` MUST infer yielded Service instances and method requirements. Their factories MAY return marker-free structural contracts; release callbacks MUST receive the branded exact instance, and `scopedGen` release MUST also receive `ScopeOutcome`.

#### Scenario: Generator dependency is inferred

- **WHEN** a UserRepository factory yields Database
- **THEN** the Layer MUST provide UserRepository and require Database

#### Scenario: Scope adds no Service requirement

- **WHEN** a factory uses Scope but yields no Service constructor
- **THEN** Scope MUST NOT enter the Layer requirement union

#### Scenario: Release receives exact public types

- **WHEN** TypeScript infers a scoped generator release callback
- **THEN** its parameters MUST be exactly the requested Service instance and `ScopeOutcome`

## ADDED Requirements

### Requirement: Scoped generator providers preserve Layer requirements

The type of `Layer.scopedGen(Service, factory, release)` MUST identify the requested Service as provided and MUST include both the Service's declared requirements and every Service token yielded by the factory in its required-Service union.

#### Scenario: Generator dependency is inferred

- **WHEN** a `Layer.scopedGen` factory yields Database while constructing UserRepository
- **THEN** the resulting Layer MUST provide UserRepository and require Database at compile time

#### Scenario: Complete composition satisfies the dependency

- **WHEN** the scoped generator Layer is merged with a Layer that provides every inferred dependency
- **THEN** the merged Layer MUST be accepted by `buildLayer` and `Runtime.make`

#### Scenario: Missing dependency remains visible

- **WHEN** a scoped generator Layer is passed to a complete-Layer boundary without a Layer for an inferred dependency
- **THEN** the missing-Service diagnostic MUST identify that dependency

### Requirement: Scoped generator callbacks retain exact public types

The factory return type and release callback parameters MUST preserve the relationship between the Service token, its instance type, and `ScopeOutcome` without exposing internal provider type erasure.

#### Scenario: Factory must return the Service instance

- **WHEN** a `Layer.scopedGen` factory returns a value that is not an instance of the requested Service type
- **THEN** TypeScript MUST reject the Layer declaration

#### Scenario: Release receives exact instance and outcome types

- **WHEN** TypeScript infers the `Layer.scopedGen` release callback parameters
- **THEN** the first parameter MUST be exactly the requested Service instance type and the second MUST be `ScopeOutcome`

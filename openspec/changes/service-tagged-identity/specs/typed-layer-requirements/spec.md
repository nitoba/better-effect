## MODIFIED Requirements

### Requirement: Composed Effects preserve Service requirements

The type of a composed Effect result MUST include the exact tag-aware,
self-bound constructor contracts for every Service inferred from its yielded
dependencies and from any returned Effect result that already carries
requirement metadata. Requirement unions MUST preserve each token's literal
tag and MUST be compared using the tagged Service compatibility rules.

#### Scenario: Direct and returned requirements are combined

- **WHEN** an Effect generator yields one Service and returns another Effect
  result requiring a different Service
- **THEN** the resulting requirement type MUST contain both exact tagged
  self-bound contracts

#### Scenario: Ordinary Results add no requirements

- **WHEN** an Effect generator returns an ordinary `better-result` Result
  without Effect requirement metadata
- **THEN** the resulting requirement type MUST remain limited to requirements
  inferred from generator yields

### Requirement: Effect requirement extraction is precise

The type-level requirement extractor MUST distribute across composed result
types, MUST treat a result without requirement metadata as requiring no
Services, and MUST retain the exact tagged self-bound contract union when
metadata is present.

#### Scenario: Unbranded Result does not become an unknown requirement

- **WHEN** the extractor is applied to a plain Result value
- **THEN** it MUST produce `never` rather than `unknown`

#### Scenario: Promise-wrapped metadata is preserved

- **WHEN** the extractor is applied to a Promise of an Effect result carrying
  tagged Service requirements
- **THEN** it MUST return the same exact tagged-contract union as the
  unwrapped result

### Requirement: Missing Layer diagnostics identify absent Services

An incomplete Layer passed to an API that requires a complete environment MUST
expose the exact missing tag-aware Service contracts through a named type-level
constraint. A requirement MUST be considered supplied only when a provided
Service has the same tag and a mutually compatible instance contract. The
standalone missing-requirements type MUST remain a union suitable for type-level
inspection.

#### Scenario: Multiple missing Services are visible

- **WHEN** a Layer requires Database and PasswordHasher but provides neither
- **THEN** its missing-requirements type MUST contain
  `ServiceToken<'Database', Database> |
ServiceToken<'PasswordHasher', PasswordHasher>` and the completeness
  constraint MUST identify that exact missing-Service set by tag

#### Scenario: Same-shape different tags remain missing

- **WHEN** a Layer requires PrimaryDatabase but provides only a structurally
  identical ReplicaDatabase with another tag
- **THEN** the missing-requirements type MUST contain
  `ServiceToken<'PrimaryDatabase', PrimaryDatabase>`

#### Scenario: Complete Layers have no missing constraint

- **WHEN** a Layer provides every required Service under the tagged compatibility
  rules
- **THEN** its missing-requirements type MUST be `never` and it MUST remain
  accepted wherever a complete Layer is required

### Requirement: Layer overrides replace provider specifications

The type-level specification of an overridden Layer MUST match runtime
replacement semantics. A replacement removes the previous specification only
for the same tagged, contract-compatible Service identity and contributes the
replacement specification instead. An incompatible same-tag replacement MUST
NOT be represented as a successful replacement.

#### Scenario: Replacement removes obsolete requirements

- **WHEN** a base Layer provider requires an extra Service only because of its
  acquisition strategy and a compatible override replaces it with one that does
  not
- **THEN** the obsolete requirement MUST not appear in the overridden Layer's
  missing-requirements type

#### Scenario: Replacement requirements remain tracked

- **WHEN** an override provider itself requires a Service
- **THEN** that requirement MUST remain in the overridden Layer's
  missing-requirements type until another provider supplies it

#### Scenario: Incompatible same-tag replacement is not accepted

- **WHEN** an override uses the same tag but an incompatible instance contract
- **THEN** the type-level boundary MUST reject it or preserve a diagnostic that
  prevents the resulting Layer from being treated as complete for the old
  contract

#### Scenario: Multiple overrides use last-write-wins semantics

- **WHEN** multiple compatible overrides target the same provided Service
- **THEN** the final type-level specification MUST correspond to the last
  override in argument order

### Requirement: Scoped generator providers preserve Layer requirements

The type of `Layer.scopedGen(Service, factory, release)` MUST identify the
requested tagged Service as provided and MUST include the exact tag-aware
self-bound contracts for both the Service's declared requirements and every
tagged Service yielded by the factory in its required-Service union.

#### Scenario: Generator dependency is inferred

- **WHEN** a `Layer.scopedGen` factory yields Database while constructing
  UserRepository
- **THEN** the resulting Layer MUST provide UserRepository and require
  `ServiceToken<'Database', Database>` at compile time

#### Scenario: Complete composition satisfies the dependency

- **WHEN** the scoped generator Layer is merged with a Layer that provides every
  inferred dependency under the tagged compatibility rules
- **THEN** the merged Layer MUST be accepted by complete-Layer boundaries and
  Runtime creation

#### Scenario: Missing dependency remains visible

- **WHEN** a scoped generator Layer is passed to a complete-Layer boundary
  without a Layer for an inferred dependency
- **THEN** the missing-Service diagnostic MUST identify that exact tagged
  contract

### Requirement: Scoped generator callbacks retain exact public types

The factory return type and release callback parameters MUST preserve the
relationship between the tagged Service constructor, its instance type, and
`ScopeOutcome` without exposing internal provider type erasure.

#### Scenario: Factory must return the Service instance

- **WHEN** a `Layer.scopedGen` factory returns a value that is not structurally
  assignable to the requested Service instance type
- **THEN** TypeScript MUST reject the Layer declaration

#### Scenario: Release receives exact instance and outcome types

- **WHEN** TypeScript infers the `Layer.scopedGen` release callback parameters
- **THEN** the first parameter MUST be exactly the requested Service instance
  type and the second MUST be `ScopeOutcome`

## Purpose

Provides precise, readable compile-time dependency metadata when Effect programs and Layers are composed, without changing their runtime behavior or public generic model.

## ADDED Requirements

### Requirement: Composed Effects preserve Service requirements

The type of a composed Effect result MUST include Service requirements inferred from its yielded Service dependencies and from any returned Effect result that already carries requirement metadata.

#### Scenario: Direct and returned requirements are combined

- **WHEN** an Effect generator yields one Service and returns another Effect result requiring a different Service
- **THEN** the resulting requirement type MUST contain both Service tokens

#### Scenario: Ordinary Results add no requirements

- **WHEN** an Effect generator returns an ordinary `better-result` Result without Effect requirement metadata
- **THEN** the resulting requirement type MUST remain limited to requirements inferred from the generator yields

### Requirement: Effect requirement extraction is precise

The type-level requirement extractor MUST distribute across composed result types and MUST treat a result without the requirement metadata property as requiring no Services.

#### Scenario: Unbranded Result does not become an unknown requirement

- **WHEN** the extractor is applied to a plain Result value
- **THEN** it MUST produce `never` rather than `unknown`

#### Scenario: Promise-wrapped metadata is preserved

- **WHEN** the extractor is applied to a Promise of an Effect result carrying Service requirements
- **THEN** it MUST return the same Service-token union as the unwrapped result

### Requirement: Missing Layer diagnostics identify absent Services

An incomplete Layer passed to an API that requires a complete environment MUST expose its missing Service tokens through a named type-level constraint, while the standalone missing-requirements type MUST remain a union suitable for type-level inspection.

#### Scenario: Multiple missing Services are visible

- **WHEN** a Layer requires Database and PasswordHasher but provides neither
- **THEN** its missing-requirements type MUST be `Database | PasswordHasher` and the completeness constraint MUST identify that missing-Service set by name

#### Scenario: Complete Layers have no missing constraint

- **WHEN** a Layer provides every required Service
- **THEN** its missing-requirements type MUST be `never` and it MUST remain accepted wherever a complete Layer is required

### Requirement: Layer overrides replace provider specifications

The type-level specification of an overridden Layer MUST match runtime replacement semantics: a replacement removes the previous specification for the same provided Service and contributes the replacement specification instead.

#### Scenario: Replacement removes obsolete requirements

- **WHEN** a base Layer provider requires an extra Service only because of its acquisition strategy and an override replaces that provider with one that does not
- **THEN** the obsolete requirement MUST not appear in the overridden Layer's missing-requirements type

#### Scenario: Replacement requirements remain tracked

- **WHEN** an override provider itself requires a Service
- **THEN** that requirement MUST remain in the overridden Layer's missing-requirements type until another provider supplies it

#### Scenario: Multiple overrides use last-write-wins semantics

- **WHEN** multiple overrides target the same provided Service
- **THEN** the final type-level specification MUST correspond to the last override in argument order

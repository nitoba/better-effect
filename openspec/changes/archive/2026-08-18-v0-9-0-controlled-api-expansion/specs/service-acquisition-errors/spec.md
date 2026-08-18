## Purpose

Defines stable, container-agnostic diagnostics for infrastructure failures that
occur while a Runtime resolves or constructs a Service.

## ADDED Requirements

### Requirement: Missing Service providers produce a rich infrastructure error

Resolving a Service tag with no registered provider MUST fail with `ServiceNotFoundError`. The error MUST identify the requested logical Service tag and MUST not expose adapter-specific identifiers as the public identity.

#### Scenario: No provider is registered

- **WHEN** a Runtime resolves `Database` without a Database provider
- **THEN** resolution MUST fail with `ServiceNotFoundError` naming the Database tag and MUST NOT call an acquisition callback

### Requirement: Circular Service resolution reports its path

When Service resolution re-enters a tag already in the active resolution path, the Runtime MUST fail with `CircularDependencyError`. The diagnostic MUST retain the ordered cycle path, including the repeated tag, and MUST remain distinguishable from a missing provider.

#### Scenario: A two-Service cycle is detected

- **WHEN** `Database` requires `Repository` and `Repository` requires `Database`
- **THEN** resolution MUST fail with `CircularDependencyError` whose path identifies both Services and the repeated `Database`

### Requirement: Provider construction failures are wrapped without losing the cause

If a registered Service provider throws or rejects while being acquired, the Runtime MUST fail with `ServiceAcquisitionError` containing the logical Service token, the active resolution path, and the original cause. Existing rich infrastructure errors MUST NOT be needlessly double-wrapped.

#### Scenario: Provider throws during lazy acquisition

- **WHEN** a Database provider throws `cause`
- **THEN** resolution MUST reject with `ServiceAcquisitionError`, and `error.cause` MUST be the exact `cause`

#### Scenario: Provider rejects asynchronously

- **WHEN** a provider returns a rejected Promise
- **THEN** the same `ServiceAcquisitionError` contract MUST apply and the resolution path MUST remain available

### Requirement: Domain errors remain owned by Service behavior

Infrastructure diagnostics MUST apply only to Service resolution and construction. Errors returned by a resolved Service's domain methods MUST remain in that method's declared Effect/Result error channel and MUST NOT be reclassified as acquisition defects.

#### Scenario: A resolved Service returns a domain error

- **WHEN** an acquired repository returns `Result.err(DomainError)` from a method
- **THEN** the caller MUST receive `DomainError` through the method's declared error channel, not as `ServiceAcquisitionError`


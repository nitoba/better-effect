## ADDED Requirements

### Requirement: Disposable registration requires a disposal protocol

The public `DisposableResource` type MUST require at least one callable `Symbol.dispose` or `Symbol.asyncDispose` member. `Scope.add(resource)` MUST accept such resources, preserve their exact subtype in its return value, and register one disposer in the Scope. Values with neither statically known protocol MUST be rejected by TypeScript, while runtime validation MUST continue to reject invalid values that cross an unsafe or untyped boundary with `ResourceNotDisposableError`.

#### Scenario: Synchronous disposable satisfies the contract

- **WHEN** a value has a callable `Symbol.dispose` member and no `Symbol.asyncDispose` member
- **THEN** it MUST satisfy `DisposableResource` and be accepted by `Scope.add`

#### Scenario: Asynchronous disposable satisfies the contract

- **WHEN** a value has a callable `Symbol.asyncDispose` member and no `Symbol.dispose` member
- **THEN** it MUST satisfy `DisposableResource` and be accepted by `Scope.add`

#### Scenario: Plain object is rejected statically

- **WHEN** a caller passes an object with neither disposal symbol to `Scope.add`
- **THEN** TypeScript MUST reject the call

#### Scenario: Unsafe invalid value is rejected dynamically

- **WHEN** an untyped or explicitly cast value with neither disposal protocol reaches `Scope.add`
- **THEN** registration MUST fail with `ResourceNotDisposableError` and no finalizer MUST be registered

### Requirement: Disposable registration uses deterministic cleanup

If a resource implements both disposal protocols, Scope cleanup MUST prefer `Symbol.asyncDispose` and MUST NOT also invoke `Symbol.dispose`. If the Scope begins closing before registration completes, `Scope.add` MUST immediately invoke the selected disposer so ownership is not leaked; a simultaneous registration and disposal failure MUST preserve both causes.

#### Scenario: Asynchronous disposal takes precedence

- **WHEN** a registered resource implements both `Symbol.asyncDispose` and `Symbol.dispose`
- **THEN** Scope closure MUST invoke and await only `Symbol.asyncDispose`

#### Scenario: Closed Scope immediately disposes

- **WHEN** a valid disposable is added after the Scope has begun closing
- **THEN** the selected disposer MUST run immediately and the add operation MUST still report the closed-Scope failure

#### Scenario: Immediate disposal failure is aggregated

- **WHEN** adding to a closing Scope fails and the immediate disposer also fails
- **THEN** the operation MUST preserve both the registration failure and disposal failure without losing either cause

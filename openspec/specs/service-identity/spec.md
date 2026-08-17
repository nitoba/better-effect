# service-identity Specification

## Purpose

Defines stable, declaration-only Service instance identity while preserving class constructors as runtime resolver and Layer registration tokens.

## Requirements

### Requirement: Services use non-empty literal tags

The public declaration API MUST use `Service<Self>()('Tag')`. The explicit self type MUST preserve exact instance inference, and the tag MUST be a non-empty string literal.

#### Scenario: Literal tag declares a Service

- **WHEN** an application declares `class Database extends Service<Database>()('Database')`
- **THEN** the declaration MUST compile and the constructor MUST remain a yieldable dependency handle

#### Scenario: Widened or empty tags are rejected

- **WHEN** a declaration receives a widened `string` or an empty literal
- **THEN** TypeScript MUST reject it, with a runtime empty-tag guard allowed defensively

### Requirement: Service instances carry declaration-only identity

Every declared Service instance MUST satisfy `ServiceIdentity<Tag>`. The identity member MUST be required in the type system, declaration-only, inaccessible to ordinary structural implementations, and absent from emitted JavaScript and runtime objects.

#### Scenario: Yield returns the exact branded instance

- **WHEN** an Effect generator evaluates `yield* Database`
- **THEN** the value and public Effect requirement MUST both be exactly `Database`

#### Scenario: Unrelated objects are not environments

- **WHEN** `{}`, `object`, `unknown`, a primitive, or an arbitrary interface is used as `Effect<A, E, R>`
- **THEN** TypeScript MUST reject the environment because it lacks Service identity

#### Scenario: Runtime objects contain no identity marker

- **WHEN** a Service instance or generated JavaScript is inspected
- **THEN** no Service identity symbol or property MUST exist at runtime

### Requirement: Structural implementation boundaries remove identity

`Service.Contract<S>` and `ServiceContract<S>` MUST project the marker-free behavioral contract. `Service.of` and every Layer provider API MUST accept that structural contract and return or provide the branded Service type without adding runtime metadata.

#### Scenario: Structural fake is accepted

- **WHEN** `Database.of({ query: () => 'fake' })` or `Layer.succeed(Database, { query: () => 'fake' })` is used
- **THEN** the input MUST not need an identity marker and the resulting public type MUST be `Database`

#### Scenario: Recursive contracts remain compatible

- **WHEN** same-tag Services contain self-returning methods or recursively nested `Promise<Self>` values
- **THEN** their marker-free contracts MUST remain comparable without excessive type instantiation

### Requirement: Public instance helpers recover tags and canonical tokens

`Service.Tag<S>` MUST read the literal tag from a branded instance. `Service.TokenOf<S>` MUST distribute over instance unions and produce canonical `Service.Token<Tag, Instance>` contracts. Exact constructors remain separately available where a constructor value is held.

#### Scenario: Tag and token are recovered

- **WHEN** helpers are applied to `Database`
- **THEN** `Service.Tag<Database>` MUST be `'Database'` and `Service.TokenOf<Database>` MUST be `Service.Token<'Database', Database>`

#### Scenario: Resolver preserves the concrete constructor relationship

- **WHEN** `ServiceRuntime.resolve(Database)` is called
- **THEN** the awaited value MUST be inferred exactly as `Database` through `T -> InstanceType<T>`

### Requirement: Compatibility uses tag and marker-free contract

Different literal tags MUST remain incompatible even when behavior is identical. Same-tag Services MAY satisfy or override one another only when `Service.Contract` shapes are bidirectionally compatible. Constructor parameters, custom statics, and constructor names MUST NOT affect instance compatibility.

#### Scenario: Same shape with different tags is rejected

- **WHEN** PrimaryDatabase and ReplicaDatabase expose identical methods under different tags
- **THEN** a Layer or Runtime providing ReplicaDatabase MUST NOT satisfy PrimaryDatabase

#### Scenario: Same-tag compatible override succeeds

- **WHEN** two same-tag constructors have compatible behavior but different constructor parameters or custom statics
- **THEN** `Layer.override` MUST accept the call, represent the replacement instance in `Layer.Provided`, and retain the winning constructor at runtime

#### Scenario: Same-tag incompatible override is rejected

- **WHEN** same-tag declarations have incompatible behavioral contracts
- **THEN** `Layer.override` MUST reject the call directly with a typed diagnostic

### Requirement: Runtime identity remains constructor and tag based

Resolvers and Layer backends MUST continue to receive class constructors. Provider lookup MUST use `serviceTag`, retain the registering constructor, isolate different tags, and reject incompatible same-tag requests best-effort.

#### Scenario: Yield resolves with the constructor

- **WHEN** a program evaluates `yield* Database`
- **THEN** `ServiceRuntime` MUST pass the `Database` constructor to the resolver

#### Scenario: Missing tag retains runtime diagnostics

- **WHEN** no provider exists for the requested tag
- **THEN** resolution MUST fail with the existing Service-not-found behavior naming that tag

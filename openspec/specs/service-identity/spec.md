# service-identity Specification

## Purpose

Defines an explicit, stable identity for Services that is preserved from
TypeScript requirements through Layer composition, Runtime validation, and
dependency-backend resolution.

## Requirements

### Requirement: Services use non-empty literal tags

The public Service declaration API MUST accept a non-empty string literal as
the Service identity while retaining an explicit self type for exact TypeScript
inference. A widened `string` value MUST be rejected at compile time, and the
legacy untagged self-type declaration form MUST no longer be the supported
public model.

#### Scenario: Literal tag declares a Service

- **WHEN** an application declares
  `class Database extends Service<Database>()('Database')`
- **THEN** the declaration MUST compile and the class MUST remain usable as a
  dependency handle

#### Scenario: Const literal tag is accepted

- **WHEN** an application passes a `const` value whose type is the literal
  `'Database'` to `Service<Database>()(...)`
- **THEN** the Service declaration MUST preserve that literal identity

#### Scenario: Widened tag is rejected

- **WHEN** an application passes a value typed as `string` to `Service`
- **THEN** TypeScript MUST reject the declaration rather than widening every
  Service identity to `string`

#### Scenario: Empty tag is rejected

- **WHEN** an application passes an empty string to `Service`
- **THEN** the declaration MUST be rejected at the public type boundary, with a
  runtime guard allowed as a defensive fallback

### Requirement: Service handles preserve exact instances and tagged contracts

The class returned by a tagged Service declaration MUST remain the ergonomic
runtime and type-level handle. Resolving or yielding that handle MUST return
its exact instance type, and its requirement metadata MUST carry the literal
tag together with the declaration's self-bound constructor contract rather than
reconstructing a token from the instance shape.

#### Scenario: Yield returns the exact Service instance

- **WHEN** an Effect generator evaluates `yield* Database`
- **THEN** the yielded value MUST be inferred exactly as `Database`

#### Scenario: Effect requirements carry the tagged self contract

- **WHEN** an Effect program yields `Database`
- **THEN** `EffectRequirements` MUST contain `ServiceToken<'Database', Database>`
  and MUST preserve the literal tag and self type

#### Scenario: Resolver preserves the concrete token relationship

- **WHEN** `ServiceRuntime.resolve(Database)` is called
- **THEN** its awaited result MUST be inferred exactly as `Database`

### Requirement: Service compatibility uses tag and contract identity

Service requirement satisfaction MUST first compare the literal Service tags.
Services with different tags MUST remain distinct even when their instance
contracts are structurally identical. Services with the same tag MAY represent
one logical identity only when their instance contracts are mutually
compatible; incompatible same-tag declarations MUST NOT satisfy one another.

#### Scenario: Identical contracts with different tags remain distinct

- **WHEN** `PrimaryDatabase` and `ReplicaDatabase` expose identical methods but
  are declared with different tags
- **THEN** a Layer or Runtime providing only `ReplicaDatabase` MUST NOT satisfy
  a requirement for `PrimaryDatabase`

#### Scenario: Same tag and compatible contracts share logical identity

- **WHEN** two declarations use the same tag and their instance contracts are
  mutually assignable
- **THEN** type-level requirement matching MAY treat them as the same logical
  Service identity

#### Scenario: Same tag and incompatible contracts do not match

- **WHEN** two declarations use the same tag but one requires members absent
  from the other
- **THEN** neither declaration MUST satisfy a requirement for the other

### Requirement: Layer composition protects Service-tag collisions

Layer composition MUST use the Service tag as the provider identity. A merge
MUST reject duplicate tags. An override MUST replace a provider only when the
replacement is compatible with the existing logical identity; an incompatible
same-tag replacement MUST fail rather than silently changing the provided
contract.

#### Scenario: Duplicate tags are rejected by merge

- **WHEN** two Layers provide different Service declarations with the same tag
- **THEN** merging them MUST fail with a duplicate/collision error that names
  the tag

#### Scenario: Compatible override replaces the previous provider

- **WHEN** an override supplies a compatible provider for an existing Service
  tag
- **THEN** the resulting Layer MUST expose the replacement provider and its
  requirements, without retaining obsolete requirements from the replaced
  provider

#### Scenario: Incompatible override is rejected

- **WHEN** an override supplies a same-tag provider with an incompatible
  instance contract
- **THEN** the override MUST fail or be rejected by its boundary and MUST NOT
  leave a Layer whose type claims the old contract while runtime resolves the
  new one

### Requirement: Runtime backends resolve by Service tag safely

The built-in dependency backends MUST use the Service tag for provider,
instance, and pending-acquisition identity while retaining the registering
constructor for diagnostics and collision checks. Requests for different tags
MUST remain isolated, and an unavailable tag MUST produce the existing
Service-not-found behavior.

#### Scenario: Different tags resolve independently

- **WHEN** two structurally identical Services have different tags and both
  are registered
- **THEN** resolving either handle MUST return its own provider and MUST NOT
  return the other instance

#### Scenario: Same-tag incompatible resolution is not silent

- **WHEN** a backend encounters a request and registered association for the
  same tag that is incompatible with the requested Service contract
- **THEN** it MUST reject the association with a structural collision error or
  an equivalent failure, rather than returning the wrong instance

#### Scenario: Missing tags retain diagnostics

- **WHEN** a program requests a tag that has no registered provider
- **THEN** resolution MUST fail with a Service-not-found error that identifies
  the tag

### Requirement: Implementations remain structurally assignable

Selecting a Service identity MUST NOT require the acquired implementation or a
test double to carry the tag, a user-declared brand, a decorator, or a symbol.
Layer creation MUST continue to accept any value structurally assignable to the
requested Service instance contract.

#### Scenario: Structural fake implementation is accepted

- **WHEN** a Layer supplies an object implementing the requested Service
  methods without extending the Service class
- **THEN** the Layer declaration MUST remain accepted

#### Scenario: Mocks do not repeat identity metadata

- **WHEN** a test supplies a structural mock for a tagged Service
- **THEN** the mock MUST NOT need to declare the Service tag or any additional
  identity property

### Requirement: Public documentation uses the tagged declaration

The package's public examples and guidance MUST use
`Service<Self>()('Name')` as the recommended declaration form, explain that the
string is the stable logical identity and the self type preserves exact
inference, and document the different-tag behavior for structurally similar
Services. The old untagged `Service<Self>()` syntax MUST NOT remain in migrated
examples or type contracts.

#### Scenario: Main example shows the new API

- **WHEN** a consumer reads the main README or the executable example
- **THEN** Service declarations MUST use literal tags with the explicit self
  type and `yield*` MUST still be shown as the access pattern

### Requirement: Public API declarations are documented

Every class, method, function, error class, and public type contract exposed by
the package entry points MUST have declaration-site JSDoc explaining its role
and relevant lifecycle or error semantics. Primary entry points SHOULD include
short TypeScript usage examples, and the documentation MUST be preserved in
the generated declaration files used by consumers.

#### Scenario: Editor help explains a primary entry point

- **WHEN** a consumer opens autocomplete or go-to-definition for `Service`,
  `Layer`, `Effect`, `Runtime`, `Scope`, `Resource`, or `pipe`
- **THEN** the generated declaration MUST expose a concise description and a
  relevant usage example where the API has non-obvious setup or lifecycle
  behavior

#### Scenario: Public errors and contracts are discoverable

- **WHEN** a consumer inspects an exported error class or type such as
  `ServiceNotFoundError`, `ScopeOutcome`, or `AcquireUseReleaseOptions`
- **THEN** its declaration MUST explain when it is used and what its public
  fields or members represent

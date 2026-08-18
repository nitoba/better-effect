# typed-layer-requirements Specification

## Purpose

Defines the instance-facing Layer environment contract, precise composition
semantics, and named compile-time completeness diagnostics without changing
Result or Layer runtime behavior.

## Requirements

### Requirement: Effects use tagged Service instance requirements

The canonical public program type MUST be `Effect<A, E, R extends Service.Any = never>`, where `R` is a union of tagged Service instances. The type MUST remain a type-only facade over `better-result` and MUST add no runtime Effect representation. Every Effect combinator that returns an Effect MUST preserve the input requirement union or union it with the requirements of every Effect it can evaluate.

#### Scenario: Direct and returned requirements are combined

- **WHEN** a generator yields Database and returns an Effect requiring Logger
- **THEN** the result MUST be `Effect<A, E, Database | Logger>`

#### Scenario: Ordinary Results add no requirements

- **WHEN** a generator returns a plain `better-result` Result and yields no Service
- **THEN** `Effect.Requirements` MUST be `never`

#### Scenario: Mapping preserves requirements

- **WHEN** `Effect<A, E1, Database>` is mapped to another success type
- **THEN** the result MUST retain `Database` as its exact requirement channel

#### Scenario: Chaining unions requirements and errors

- **WHEN** `Effect<A, E1, Database>` is chained to an Effect requiring Cache and returning `B` with error `E2`
- **THEN** the result MUST be `Effect<B, E1 | E2, Database | Cache>`

#### Scenario: Collection combinators union every input

- **WHEN** `Effect.all` or `Effect.zip` combines Effects requiring Database and Cache
- **THEN** the output MUST retain the union `Database | Cache` and MUST NOT widen it to `Service.Any`

#### Scenario: Lazy Program collection preserves requirements

- **WHEN** `Program.all` combines Programs requiring Database and Cache
- **THEN** the returned Program MUST expose `Database | Cache` as its final requirement channel

### Requirement: Layer exposes two public environment channels

The public Layer class MUST have exactly two generic parameters: `Layer<Provided, Required>`. Both channels MUST be tagged Service instance unions. `Provided` MUST be invariant and `Required` MUST be covariant. `Layer.Provided<L>`, `Layer.Required<L>`, `Layer.Complete<L>` and `Layer.Any` are the only public Layer inspection aliases.

`Provided` MUST contain the Services produced by the Layer. `Required` MUST contain only requirements external to the composed Layer after all retained providers are considered.

#### Scenario: Provider construction uses instance channels

- **WHEN** `Layer.make(Database)` is declared
- **THEN** its public type MUST provide `Database` and require `Service.Requirements<Database>` after external subtraction

#### Scenario: Generator dependency is inferred

- **WHEN** a UserRepository generator yields Database
- **THEN** the Layer MUST be `Layer<UserRepository, Database>` before Database is composed

#### Scenario: Composition removes supplied requirements

- **WHEN** `AppLive = Layer.merge(Layer.make(Database), UserRepositoryLive)` and UserRepositoryLive requires Database and Config
- **THEN** `Layer.Provided<typeof AppLive>` MUST be `Database | UserRepository` and `Layer.Required<typeof AppLive>` MUST be `Config`

#### Scenario: Empty composition is empty

- **WHEN** `Layer.merge()` is declared
- **THEN** its public channels MUST be `never` and `never`

### Requirement: Provider provenance is package-private and declaration-only

Inferred Layers MUST carry precise per-provider requirement provenance through a package-private declaration-only unique-symbol carrier. Explicit `Layer<Provided, Required>` annotations MUST erase precise ownership into an opaque provided environment with sticky requirements. The carrier MUST emit no JavaScript and MUST NOT be exported from a public barrel.

#### Scenario: Precise override removes only the replaced requirement

- **WHEN** one inferred provider requires Database, another requires Config, and the first is replaced by a requirement-free compatible provider
- **THEN** only Database MUST be removed from the resulting external `Layer.Required` channel

#### Scenario: Erased requirements remain conservative

- **WHEN** an explicitly annotated `Layer<Mailer, Config>` is overridden with a compatible Mailer provider
- **THEN** Config MUST remain required unless the final provided environment independently satisfies Config

#### Scenario: Satisfies preserves inference

- **WHEN** an inferred Layer is checked with `satisfies Layer<Provided, Required>`
- **THEN** the public contract MUST be checked without discarding its private provenance

### Requirement: Layer requirements use tag and bidirectional contract matching

A concrete requirement MUST be supplied only by a Service with the same literal `serviceTag` and a bidirectionally compatible `Service.Contract` shape. Different tags MUST never satisfy one another, even when method shapes are identical. Self-requirements supplied by the Layer's own `Provided` channel MUST be removed.

#### Scenario: Same-shape different tag remains external

- **WHEN** a Layer requires PrimaryDatabase and provides same-shaped ReplicaDatabase
- **THEN** `Layer.Required` MUST still contain PrimaryDatabase

#### Scenario: Self requirement is internal

- **WHEN** a Service method requires its own Service and the Layer provides that Service
- **THEN** the self requirement MUST NOT appear in `Layer.Required`

### Requirement: Complete Layer boundaries name missing dependencies

A typed concrete Layer is complete only when `Layer.Required<L>` is exactly `never`. An incomplete Layer crossing a complete boundary MUST intersect with package-private `MissingDependencies<Layer.Required<L>>`. `Layer.Complete<L>` MUST classify the original input shape before applying this check.

#### Scenario: Compiler diagnostic is readable

- **WHEN** a Layer requires Database but no Database provider is composed
- **THEN** the boundary MUST contain `MissingDependencies<Database>`

#### Scenario: Complete Layer has no missing diagnostic

- **WHEN** every concrete external requirement is supplied
- **THEN** `Layer.Required<L>` MUST be `never` and no MissingDependencies intersection is required

### Requirement: Erasure and union boundaries are explicit

Only exact `Layer<any, any>`, exact `Layer<never, any>`, and exact `Layer.Any` MAY be unchecked Layer erasure sentinels. Partial-`any` shapes, bare or one-argument Layers, widened `Service.Any` channels, and concrete Layer unions MUST NOT be silently widened to `Layer.Any`.

#### Scenario: Exact sentinels propagate

- **WHEN** an exact unchecked sentinel participates in merge or override
- **THEN** the result MUST be `Layer<any, any>` and ordinary completeness checks MUST be skipped

#### Scenario: Partial erasure is rejected

- **WHEN** `Layer<Database, any>` or `Layer<any, never>` crosses merge, override, `Layer.Complete`, or a Runtime boundary
- **THEN** TypeScript MUST reject it with a package-private invalid-erasure diagnostic

#### Scenario: Concrete Layer union is rejected

- **WHEN** a value has type `Layer<Database, never> | Layer<Logger, never>`
- **THEN** merge, override and complete Runtime boundaries MUST reject the original union rather than flattening it

#### Scenario: Widened Service.Any is not a Layer sentinel

- **WHEN** a typed Layer contains widened `Service.Any` in a channel
- **THEN** it MUST remain incomplete and MUST NOT prove concrete requirement satisfaction or override compatibility

### Requirement: Overrides reject incompatible contracts at the call site

`Layer.override` MUST validate every concrete same-tag pair between the current provided environment and each replacement's provided environment. Compatibility MUST compare only literal tags and bidirectional `Service.Contract` shapes. A compatible pair MUST NOT hide another incompatible pair. Ordered overrides MUST validate each replacement against the state produced by earlier replacements. The old public collision generic MUST NOT be used.

#### Scenario: Incompatible same-tag override fails immediately

- **WHEN** RichDatabase and LeanDatabase share a tag but their contracts are incompatible
- **THEN** `Layer.override(RichLive, LeanLive)` MUST fail at that call site

#### Scenario: Constructor differences do not collide

- **WHEN** compatible same-tag constructors differ in parameters, statics or names
- **THEN** override MUST succeed and the replacement instance MUST be represented in `Provided`

#### Scenario: Last compatible override wins

- **WHEN** multiple compatible overrides target one tag
- **THEN** the final replacement MUST determine the provided instance and requirements

### Requirement: Runtime provider behavior remains constructor-backed

Layer runtime storage, provider ordering, duplicate-tag errors, backend registration, lazy acquisition, Scope ownership and release behavior MUST remain unchanged. Runtime registrations MUST receive actual Service constructors, not instance values or provenance metadata.

#### Scenario: Runtime registration uses constructors

- **WHEN** a merged Layer is registered
- **THEN** the backend MUST receive the exact registering constructors in Layer order

#### Scenario: Type metadata emits no runtime values

- **WHEN** generated Services and Layer values are inspected
- **THEN** no identity or provenance symbol/property MUST be present

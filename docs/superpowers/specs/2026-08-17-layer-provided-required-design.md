# Layer Provided and Required Design

## Summary

Replace the public `Layer<Specs, Collisions>` representation with a two-channel instance environment:

```ts
Layer<Provided, Required>
```

`Provided` is the union of Service instances produced by the Layer. `Required` is the union of external Service instances still needed after subtracting everything the composed Layer already provides.

For example:

```ts
const RepositoryLive = Layer.gen(UserRepository, async function* () {
  const database = yield* Database
  const config = yield* Config
  const logger = yield* Logger

  return new UserRepository(database, config, logger)
})
// Layer<UserRepository, Database | Config | Logger>

const AppLive = Layer.merge(Layer.make(Database), RepositoryLive)
// Layer<Database | UserRepository, Config | Logger>
```

Per-provider requirement provenance remains available to `merge` and `override` through declaration-only, package-private metadata. It is not a public generic parameter or package export. Type-level tokens are derived from provided instances through `Service.TokenOf<Provided>`; runtime providers continue to retain their actual registering constructors.

This is an intentional breaking public type-model change.

## Goals

- Make ordinary Layer types read as `Layer<Provided, Required>`.
- Use Service instance unions in both public channels.
- Make `Required` mean only dependencies that remain external to the composed Layer.
- Preserve precise requirement recomputation across inferred `merge` and `override` operations.
- Keep per-provider provenance package-private and declaration-only.
- Derive type-level token contracts from provided Service instances instead of carrying a public token channel.
- Reject incompatible same-tag overrides at the `Layer.override` call site.
- Keep runtime provider registration, resolution, Scope ownership, cleanup, and duplicate-tag behavior unchanged.
- Support TypeScript 5.7 and the current project compiler.

## Non-goals

- Do not add Effect-style typed dependency graphs, Context, MemoMap, Fiber, or Layer strategies.
- Do not move construction, caching, or provider graph ownership into core Service or Layer code.
- Do not reconstruct an exact Service constructor type from an instance type. `Service.TokenOf<S>` remains a canonical token contract rather than exact `typeof S`.
- Do not guarantee that every editor expands an inferred opaque Layer subtype using only the two public generic arguments. Consumers author only `Layer<Provided, Required>`, but package-private provenance may occasionally appear in technical tooltips.
- Do not preserve precise provider provenance after a consumer deliberately erases it with an explicit `Layer<Provided, Required>` annotation.
- Do not preserve the removed Layer metadata helper exports as deprecated aliases.

## Motivation

The current Layer representation exposes its internal provider bookkeeping:

```ts
Layer<LayerSpec<UserRepository, Database, typeof UserRepository>, never>
```

The Service requirement migration already made Effects and Runtimes use Service instances instead of constructor tokens. Layer still exposes both an implementation-oriented `LayerSpec` wrapper and `typeof UserRepository`, even though users normally need to know only what a Layer provides and what it requires.

The desired public representation is:

```ts
Layer<UserRepository, Database>
```

For multiple requirements:

```ts
Layer<UserRepository, Database | Config | Logger>
```

A simple pair of flat unions is insufficient for precise overrides. If one provider requires Database and another requires Config, replacing only the first provider must remove only its requirements. The design therefore separates the two public environment channels from an opaque internal provenance channel.

## Public Layer model

### Class parameters

The public class has exactly two generic parameters:

```ts
export class Layer<
  in out Provided extends Service.Any = Service.Any,
  out Required extends Service.Any = Service.Any
> {
  // runtime provider collection and package-private declaration metadata
}
```

`Provided` remains invariant. A Layer cannot be widened to claim that it provides Services it does not have, and it cannot silently discard an exact provided environment.

`Required` is covariant. Widening the external requirement union is conservative; narrowing it is unsafe.

A bare `Layer` is not an implicit metadata-erasure boundary. Its defaults are `Layer<Service.Any, Service.Any>`, so it is not complete and cannot be passed to Runtime boundaries. The same applies to the one-argument spelling `Layer<Provided>`, whose `Required` channel uses the default `Service.Any`.

`Layer.Any` remains the explicit unchecked spelling accepted by generic infrastructure, including the empty Layer case. Its implementation may retain the compatibility shape `Layer<any, any> | Layer<never, any>`. `Layer<any, any>` and `Layer.Any` deliberately erase completeness and override validation; composition involving either propagates an unchecked `any` environment rather than deriving a falsely precise result. `Layer<never, any>` is the erased empty-Layer branch. Widened `Service.Any` is not an unchecked Layer sentinel.

### Constructor results

All provider constructors continue to receive an actual Service class at runtime. Their public result channels use the instance type:

```ts
Layer.make(Database)
// Layer<Database, ExternalRequirements>

Layer.succeed(Database, database)
// Layer<Database, ExternalRequirements>

Layer.scoped(Database, acquire, release)
// Layer<Database, ExternalRequirements>
```

For `make`, `succeed`, and `scoped`, the raw requirement set is:

```ts
Service.Requirements<InstanceType<S>>
```

For `gen` and `scopedGen`, the raw requirement set is:

```ts
Service.Requirements<InstanceType<S>> | InferYieldRequirements<Yield>
```

The public `Required` channel always subtracts the Layer's own `Provided` channel. A self-requirement already provided by the same Layer is therefore not external.

### Empty and composed Layers

The empty merge produces:

```ts
Layer.merge()
// Layer<never, never>
```

Composition unions the provided instances and recomputes external requirements from all retained provider entries:

```ts
const DatabaseLive = Layer.make(Database)
// Layer<Database, never>

const RepositoryLive = Layer.gen(UserRepository, async function* () {
  const database = yield* Database
  const config = yield* Config

  return new UserRepository(database, config)
})
// Layer<UserRepository, Database | Config>

const AppLive = Layer.merge(DatabaseLive, RepositoryLive)
// Layer<Database | UserRepository, Config>
```

`Required` no longer means raw provider requirements. It means the environment that a caller must still supply.

### Public namespace

The public inspection API is limited to:

```ts
Layer.Any
Layer.Provided<L>
Layer.Required<L>
Layer.Complete<L>
```

For the composed example:

```ts
type Provided = Layer.Provided<typeof AppLive>
// Database | UserRepository

type Required = Layer.Required<typeof AppLive>
// Config
```

`Layer.Complete<L>` accepts a Layer unchanged when `Layer.Required<L>` is `never`. Otherwise it intersects the Layer with the existing named `MissingDependencies<Layer.Required<L>>` diagnostic.

`Layer.Missing` is removed because it would be identical to `Layer.Required` under the new semantics.

## Removed public types

Remove these package-root and Layer-barrel exports:

```ts
LayerSpec
AnyLayerSpec
LayerSpecs
Layer.Specs
AnyLayer
LayerProvided
LayerRawRequired
LayerMissing
CompleteLayer
```

Internal modules may use package-private replacements, but those names are not exported from public barrels.

Runtime/backend contracts that consumers genuinely implement remain public, including:

- `LayerBackend`;
- `LayerRegistration`;
- generator callback contracts needed by public methods;
- Runtime options and shutdown diagnostics already exposed from the Layer barrel.

Package tests must verify that removed names cannot be imported from the built package.

## Internal provider provenance

### Provider entries

Each inferred Layer result carries a declaration-only entry union under a package-private `unique symbol`:

```ts
type ProviderEntry<Provided extends Service.Any, RawRequired extends Service.Any> = {
  readonly provided: Provided
  readonly required: RawRequired
}
```

The entry does not carry a token parameter. Type-level code derives a canonical token contract when needed:

```ts
type ProviderToken<Entry> = Service.TokenOf<EntryProvided<Entry>>
```

The actual runtime `LayerProvider` continues to retain:

```ts
readonly service: Service.Class<any, any>
readonly acquire: () => MaybePromise<unknown>
readonly release?: ...
```

No runtime symbol or metadata object is added.

### Opaque result carrier

An internal result helper combines the public Layer facade with precise entries:

```ts
type LayerResult<Entries extends AnyProviderEntry> = Layer<
  EntryProvided<Entries>,
  MissingServices<EntryRawRequired<Entries>, EntryProvided<Entries>>
> &
  LayerProvenance<Entries>
```

`LayerProvenance` is package-private and keyed by a declaration-only unique symbol. Public methods may need to reference a non-exported helper in bundled declarations so TypeScript can propagate provenance. It must not be exported from package barrels and must emit no JavaScript.

The normal authored type remains `Layer<Provided, Required>`. An editor may occasionally reveal the opaque carrier when expanding an inferred value; this is acceptable. Public helpers must always project only the two instance channels.

### Explicit annotation erasure

An explicit annotation can intentionally erase exact provenance:

```ts
const app: Layer<Database | UserRepository, Config> = AppLive
```

The public environment remains safe because variance prevents dropping required Services or inventing provided Services. Subsequent composition uses a distinct opaque fallback, not an ordinary provider entry:

```ts
type ErasedProvenance<Provided, Required> = {
  readonly provided: Provided
  readonly stickyRequired: Required
}
```

`stickyRequired` is not associated with any individual provider. `override` must never remove it merely because one member of `Provided` was replaced. It can disappear only when the final provided environment independently satisfies it through the normal literal-tag and bidirectional-contract rules. `Provided = never` is valid and retains all sticky requirements. Union members inside an erased `Provided` channel remain one opaque environment and are never treated as precise per-provider entries.

For maximum precision across later overrides, documentation recommends inference or `satisfies`:

```ts
const app = AppLive

const checked = AppLive satisfies Layer<Database | UserRepository, Config>
```

When provenance is erased, an override may retain an old external requirement that can no longer be associated with a specific provider. It must never incorrectly remove a requirement.

## Composition semantics

### Merge

`Layer.merge`:

1. extracts precise entry unions when available;
2. retains erased environments as `ErasedProvenance` with sticky requirements;
3. unions the precise entries and opaque provided environments;
4. computes the public provided union;
5. subtracts the final provided environment from both precise raw requirements and sticky requirements using the existing literal-tag and bidirectional-contract matching rules;
6. propagates `any` unchanged when an input is `Layer.Any` or `Layer<any, any>`;
7. retains current runtime duplicate-tag checks and provider ordering.

Tags, not constructor names, determine Service identity.

### Override

For inferred provenance, `Layer.override` removes only entries whose provided Service has the same literal tag and a bidirectionally compatible `Service.Contract`, then adds the replacement entries and recomputes both public channels.

Example:

```ts
const RepositoryLive = Layer.gen(UserRepository, async function* () {
  const database = yield* Database
  return UserRepository.of({/* implementation */})
})

const MailerLive = Layer.gen(Mailer, async function* () {
  const config = yield* Config
  return Mailer.of({/* implementation */})
})

const Base = Layer.merge(RepositoryLive, MailerLive)
// Layer<UserRepository | Mailer, Database | Config>

const TestLive = Layer.override(Base, Layer.succeed(UserRepository, fakeRepository))
// Layer<UserRepository | Mailer, Config>
```

For erased provenance, override keeps requirements conservatively unless they are demonstrably satisfied by the final provided environment.

Overrides remain ordered left to right; the last compatible replacement for a tag wins.

### Union-typed Layer values

A concrete union such as:

```ts
Layer<Database, never> | Layer<Logger, never>
```

represents one runtime branch, not a Layer that provides both Services. Flattening it to `Layer<Database | Logger, never>` would be unsound. Concrete Layer unions are therefore rejected by `Layer.merge`, `Layer.override`, `Runtime.make`, one-shot `Runtime.run`, and `createRuntimeHandle`. The caller must narrow or resolve the branch before composition or execution.

The exact `Layer.Any` sentinel is exempt because it is already an explicit unchecked erasure. Internal union detection must test the `any`/`Layer.Any` sentinel before reporting an ambiguous Layer union. Namespace projection helpers may expose distributive inspection results for a concrete union, but `Layer.Complete<L>` must retain an ambiguous-union diagnostic and never make such a value executable.

Tuple element unions are validated individually. The implementation must not confuse the internal `Layers[number]` union used to aggregate a concrete merge tuple with one argument whose own type is a Layer union.

## Incompatible overrides

The old model stores collision metadata in `Layer`'s second generic and rejects it later at a complete-Layer boundary. That state cannot be represented safely after the second generic becomes `Required`: an explicit `Layer<Provided, Required>` annotation could erase an opaque collision marker.

The new model rejects incompatible same-tag contracts directly at `Layer.override`:

```ts
Layer.override(Base, IncompatibleReplacement)
// type error at this call
```

Compatibility still means:

1. the same literal `serviceTag`;
2. bidirectionally assignable `Service.Contract` shapes.

Different tags do not replace one another. Same-tag compatible constructors may differ in constructor parameters, names, and custom static members.

The diagnostic may use `Service.TokenOf<ReplacementProvided>` or a dedicated package-private named collision helper, but it must identify the incompatible replacement without adding a public collision generic.

Validation follows these rules:

1. every concrete same-tag pair between the current provided environment and the next replacement is checked;
2. the existence of one compatible pair does not hide another incompatible same-tag pair;
3. multiple overrides are validated left to right against the provided state produced by earlier accepted overrides;
4. concrete union-typed Layer arguments are rejected before pair validation;
5. erased provenance still validates contracts from its known concrete `Provided` union;
6. widened `Service.Any` cannot prove compatibility and is rejected for a typed override;
7. exact `Layer.Any`/`Layer<any, any>` skips validation only as an explicit unchecked escape hatch;
8. parameter constraints use the original inferred `Base` and `const Overrides` types, with `NoInfer` or an equivalent tuple intersection where necessary, so inference cannot widen an invalid argument to `Layer.Any` to evade the diagnostic.

Runtime backends continue to retain the registering constructor and perform their current best-effort member check when a different constructor with the same tag is requested. Untyped JavaScript and explicit unsafe casts therefore remain defensively checked.

## Requirement matching

The existing instance-based matching rules remain authoritative:

- `never` means no requirement;
- `any` and widened `Service.Any` retain their documented unchecked-erasure behavior;
- concrete Services match by literal tag and bidirectionally compatible `Service.Contract`;
- union matching is existential per requirement;
- one incompatible same-tag provider cannot hide another exact compatible provider;
- different tags never satisfy one another even when method shapes are equal.

The same `MissingServices<Required, Provided>` implementation should serve Layer composition and Runtime execution boundaries.

## Runtime integration

Runtime usage remains unchanged:

```ts
const runtime = await Runtime.make(AppLive, backend)
// Runtime<Layer.Provided<typeof AppLive>>
```

Internal Runtime and Layer modules may use package-private extraction helpers, but public signatures and documentation use the namespace aliases:

```ts
Layer.Any
Layer.Provided<L>
Layer.Required<L>
Layer.Complete<L>
```

Every typed complete-Layer boundary validates that `Layer.Required<L>` is `never`. `Layer<any, any>` and exact `Layer.Any` are the only explicit unchecked exceptions. Bare `Layer`, `Layer<Provided>`, and `Layer<Service.Any, Service.Any>` remain incomplete because widened `Service.Any` is not the Layer erasure sentinel.

Concrete Layer unions are rejected before completeness or provided-environment extraction. A Runtime must never turn `Layer<A, never> | Layer<B, never>` into `Runtime<A | B>`.

The runtime provider loop, backend registration, root Scope, execution child Scopes, graceful disposal, cleanup precedence, and resolver context are unchanged.

## Error handling and diagnostics

### Missing dependencies

An incomplete Layer passed to a complete boundary produces the existing named diagnostic:

```ts
MissingDependencies<Config | Logger>
```

The missing union is exactly `Layer.Required<L>`; no second subtraction occurs at the boundary.

### Duplicate providers

`Layer.merge` keeps current runtime behavior:

- duplicate use of the same constructor throws `DuplicateServiceError`;
- different constructors with the same tag throw `ServiceTagCollisionError`.

No new compile-time duplicate graph is introduced.

### Incompatible replacement

Typed incompatible replacements fail at `Layer.override`, not later at `Runtime.make`. Runtime defensive checks remain for untyped or unsafe callers.

## Compatibility and migration

This change is intentionally breaking.

Before:

```ts
const RepositoryLive: Layer<
  LayerSpec<UserRepository, Database, typeof UserRepository>,
  never
> = Layer.make(UserRepository)

type Missing = Layer.Missing<typeof AppLive>
```

After:

```ts
const RepositoryLive: Layer<UserRepository, Database> = Layer.make(UserRepository)

type Required = Layer.Required<typeof AppLive>
```

Consumers must:

- replace `Layer<LayerSpec<...>>` annotations with `Layer<Provided, Required>`;
- replace `Layer.Missing<L>` with `Layer.Required<L>`;
- replace top-level Layer inference aliases with namespace aliases;
- stop importing `LayerSpec`, `AnyLayerSpec`, or `LayerSpecs`;
- fix incompatible overrides at the `Layer.override` call site.

The minimum supported TypeScript version remains 5.7.

## Runtime behavior

No runtime behavior changes are intended:

- provider constructors remain runtime tokens;
- Layer acquisition remains lazy;
- backend registration receives constructors;
- provider order is unchanged;
- duplicate tags remain runtime errors;
- root and execution Scope ownership is unchanged;
- release callbacks receive the same instances and outcomes;
- graceful Runtime disposal is unchanged;
- no declaration identity or provenance symbol is emitted to JavaScript.

## Testing strategy

### Public Layer channels

Type tests must prove exact public projections for:

- `Layer.make`;
- `Layer.succeed`;
- `Layer.scoped`;
- `Layer.gen`;
- `Layer.scopedGen`;
- `Layer.merge()`;
- multi-provider merge;
- recursive/self requirements;
- requirements already satisfied by the Layer's own provided union.

Representative assertions include:

```ts
Layer.Provided<typeof RepositoryLive>
// UserRepository

Layer.Required<typeof RepositoryLive>
// Database | Config | Logger

Layer.Required<typeof AppLive>
// only Services still external after merge
```

### Override precision

Tests must prove:

- replacing one inferred provider removes only that provider's acquisition requirements;
- unrelated provider requirements remain;
- multiple ordered overrides retain the last compatible entry;
- compatible same-tag structural contracts replace successfully;
- Rich/Lean incompatible same-tag contracts fail at `Layer.override`;
- different-tag, same-shape Services do not replace one another;
- an explicitly erased Layer retains sticky requirements safely and conservatively;
- `Layer<never, Required>` retains all sticky requirements through override;
- concrete Layer unions fail merge, override, and complete Runtime boundaries;
- `Layer.Any` remains the only union-shaped unchecked sentinel accepted by those boundaries.

### Variance and erasure

Tests must prove:

- provided Services cannot be invented or silently discarded;
- required Services cannot be narrowed;
- conservative requirement widening is accepted;
- bare `Layer` and `Layer<P>` are incomplete rather than unchecked;
- `Layer<Service.Any, Service.Any>` does not inherit Runtime's widened-Service erasure behavior;
- `Layer.Any` and `Layer<any, any>` are explicit unchecked sentinels and propagate `any` through merge, override, and Runtime boundaries;
- `Layer.Any` accepts ordinary and empty Layers;
- zero-argument merge, `Layer<never, Required>`, and empty override tuples preserve their defined channels;
- `satisfies Layer<P, R>` checks the public contract without erasing inferred provenance.

### Package surface

Built-package tests under TypeScript current and 5.7 must verify:

- `Layer<P, R>` is importable and usable in consumer annotations;
- `Layer.Provided`, `Layer.Required`, `Layer.Complete`, and `Layer.Any` work;
- removed public names fail to import;
- emitted Service subclasses and Layer declarations remain portable;
- package-private provenance helpers emit no JavaScript;
- complete and incomplete diagnostics retain `MissingDependencies<...>`;
- incompatible override diagnostics occur at the override call.

### Runtime regression

All existing runtime tests must continue to pass. Focused tests should confirm that registrations and backend resolutions still receive actual constructors, not instance values or phantom metadata.

## Documentation and specification updates

Update together:

- package README;
- Layers, Runtime, Services, testing, troubleshooting, and getting-started docs where Layer types or missing requirements appear;
- `examples/todo-api` annotations if affected;
- project guidance in `AGENTS.md`;
- main OpenSpec Layer and Runtime requirement contracts;
- public namespace and package declaration fixtures.

Archived OpenSpec changes remain untouched.

Documentation should prefer inferred Layers and use `satisfies Layer<P, R>` when checking an explicit boundary without losing provenance.

## Affected implementation areas

Expected areas include:

- `packages/better-effect/src/layer/types.ts`;
- `packages/better-effect/src/layer/inference.ts`;
- `packages/better-effect/src/layer/layer.ts`;
- `packages/better-effect/src/layer/runtime.ts`;
- `packages/better-effect/src/layer/index.ts`;
- `packages/better-effect/src/runtime/runtime.ts`;
- `packages/better-effect/src/runtime/types.ts`;
- `packages/better-effect/src/index.ts`;
- Layer, Runtime, variance, namespace, and package declaration type tests;
- runtime regression tests;
- README, docs, AGENTS, and current OpenSpec specifications.

## Acceptance criteria

- Consumers author `Layer<Provided, Required>` with exactly two public generic parameters.
- `Provided` and `Required` are Service instance unions.
- `Required` contains only dependencies external to the composed Layer.
- `Layer.merge` removes requirements supplied by any retained provider.
- Inferred `Layer.override` precisely removes only the replaced provider's requirements.
- Explicit provenance erasure remains type-safe and conservative.
- Incompatible same-tag overrides fail at `Layer.override` without inference widening around the diagnostic.
- Concrete union-typed Layers are rejected by composition and Runtime boundaries; exact `Layer.Any` remains explicitly unchecked.
- Bare and one-argument Layer annotations are incomplete, while `Layer<any, any>` is explicitly unchecked.
- `LayerSpec`, spec helpers, `Layer.Missing`, and top-level Layer inference aliases are absent from public exports.
- Type-level token contracts are derived from provided instances; runtime providers still retain actual constructors.
- Missing Layer dependencies use `MissingDependencies<Layer.Required<L>>`.
- Runtime registration, resolution, Scope, cleanup, and disposal behavior do not change.
- No provenance or identity metadata is emitted to JavaScript.
- The current compiler and TypeScript 5.7 package suites pass.

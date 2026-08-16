# Instance Service Requirements Design

## Summary

Make Service instance types the public representation of application environments and Effect requirements. A program that needs Database and Logger will be represented as:

```ts
Effect<User, UserError, Database | Logger>
```

Service constructors remain the runtime resolver tokens and Layer registration handles. Each Service instance type gains a type-only identity that carries its literal tag and corresponding constructor token, allowing type-level infrastructure to recover exact identity without exposing `typeof Database` in ordinary Effect, Layer, or Runtime types.

Replace the current underscored missing-Service diagnostic properties with a named `MissingDependencies<Missing>` diagnostic so compiler errors identify instance requirements directly.

This is an intentional breaking public type-model change. Backward compatibility with `EffectResult<A, E, typeof Database>` is not required.

## Goals

- Represent Effect requirements as readable Service instance unions.
- Expose a public type-only `Effect<A, E, R>` over `better-result`.
- Use the same instance-based environment representation in Service, Layer, and Runtime public types.
- Preserve exact literal-tag identity when two Services have identical implementation shapes.
- Keep constructors as resolver tokens and backend registration handles.
- Preserve structural implementations through `Service.of` and Layer provider boundaries.
- Replace internal-looking missing-Service diagnostics with `MissingDependencies<...>`.
- Add no runtime representation, scheduler, Context, Fiber, or dependency.
- Support TypeScript 5.2.2 and the current project compiler.

## Non-goals

- Do not emulate Effect TS execution semantics.
- Do not introduce lazy Effect values, interruption, fibers, scheduling, or Context.
- Do not change `better-result` Result semantics or generator short-circuiting.
- Do not move Service construction, caching, or graph ownership into core Service or Layer code.
- Do not move runtime Service identity away from literal `serviceTag` values.
- Do not preserve the old `EffectResult<A, E, TokenUnion>` public type spelling.
- Do not guarantee exact editor hover formatting beyond exposing a named `Effect<A, E, R>` signature with an exact instance-side `R`.
- Do not expose `MissingDependencies` as an application API merely because it appears in compiler diagnostics; application code inspects missing requirements through `Layer.Missing` and Effect requirement helpers.

## Motivation

The current requirement channel carries constructor tokens:

```ts
type Program = EffectResult<
  User,
  UserError,
  typeof Database | typeof Logger
>
```

This is correct because constructors own `serviceTag`, but it makes the public environment harder to read than the application architecture it describes. It also creates an unsafe loophole: `EffectResult<User, UserError, Database>` compiles because the requirement parameter is unconstrained, then token-only missing-Service logic treats the instance type as no requirement.

A separate instance projection would improve inspection aliases but would not improve the primary inferred program type. The desired primary representation is:

```ts
Effect<User, UserError, Database | Logger>
```

Achieving that safely requires Service identity on the instance side rather than a presentation-only projection.

## Architecture

### Dual role of a Service declaration

A Service declaration keeps its current runtime roles:

```ts
class Database extends Service<Database>()('Database') {
  query(): Promise<User> {
    // ...
  }
}
```

At runtime, `Database` remains:

1. the class constructor;
2. the resolver token;
3. the Layer registration handle;
4. the yieldable dependency handle.

In the type system, the instance `Database` additionally carries a hidden, optional identity:

```ts
declare const ServiceIdentityTypeId: unique symbol

type ServiceIdentity<Tag extends string, Token> = {
  readonly [ServiceIdentityTypeId]?: {
    readonly tag: Tag
    readonly token: Token
  }
}
```

The generated Service base contributes an identity equivalent to:

```ts
ServiceIdentity<'Database', typeof Database>
```

The property is declared only. It is never initialized or emitted.

### Why the identity is optional

The marker must distinguish declared Service types while allowing structural implementations:

```ts
const fake = Database.of({
  query: async () => user
})
```

An optional unique-symbol member remains part of `Database`'s type identity but does not require application implementations to manufacture inaccessible metadata. Type-contract tests must prove both properties:

- differently tagged, same-shape Service types are incompatible;
- marker-free structural implementations remain accepted.

### Recovering tags and tokens

Internal type helpers recover exact metadata from the instance type:

```ts
type ServiceIdentityOf<S> = // identity marker payload
type ServiceTagOf<S> = ServiceIdentityOf<S>['tag']
type ServiceTokenOf<S> = ServiceIdentityOf<S>['token']
```

Public Service helpers expose the useful relationships:

```ts
type Tag = Service.Tag<Database>
// 'Database'

type Token = Service.TokenOf<Database>
// typeof Database
```

Runtime resolver APIs continue to enforce the constructor-to-instance relationship:

```ts
resolve<T extends AnyServiceToken>(token: T): InstanceType<T> | PromiseLike<InstanceType<T>>
```

## Public Effect type

The exported `Effect` value, generic type, and declaration-only namespace coexist under TypeScript's separate value and type namespaces. This shape was validated with declaration emit on TypeScript 5.2.2.

```ts
export type Effect<
  A,
  E,
  R extends AnyService = never
> = ResultType<A, E> & {
  readonly [EffectRequirementsTypeId]?: R
}
```

`AnyService` is the widened instance-side identity constraint, not a constructor token.

The existing runtime value remains unchanged:

```ts
export const Effect = {
  gen,
  acquireRelease,
  add,
  map,
  mapError,
  andThen,
  andThenAsync
} as const
```

The merged namespace inspects the public channels:

```ts
type Success = Effect.Success<Program>
type Failure = Effect.Error<Program>
type Requirements = Effect.Requirements<Program>
```

For:

```ts
const program = Effect.gen(async function* () {
  const database = yield* Database
  const logger = yield* Logger

  return database.findUser('u1')
})
```

The program carries:

```ts
Effect<User, UserError, Database | Logger>
```

and:

```ts
type Requirements = Effect.Requirements<typeof program>
// Database | Logger
```

`EffectResult` is removed as the canonical public spelling rather than retained as a competing compatibility model.

## Effect inference and composition

### Service yields

A Service iterator continues to return `Self` at runtime, but its phantom yield requirement becomes the instance-side `Self` rather than `ServiceToken<Tag, Self>`:

```ts
AsyncGenerator<ServiceRequirement<Self>, Self, unknown>
```

`ServiceRequirement` is constrained to instance-side Service identities.

### Generator results

`EffectFromGenerator` unions:

1. Service instance requirements inferred from yielded Services;
2. instance requirements already carried by a returned Effect;
3. errors yielded or returned through `better-result`.

Ordinary Results, Scope, and resource operations continue to add no Service requirements.

### Pipelines

`Effect.map` and `Effect.mapError` preserve `R`. `Effect.andThen` and `Effect.andThenAsync` union the requirements of both stages:

```ts
Effect<A, E1, Database>
  + Effect<B, E2, Logger>
  = Effect<B, E1 | E2, Database | Logger>
```

The optional readonly requirement metadata remains covariant. Public variance and built-declaration tests must continue to prevent unsafe narrowing.

## Public Service model

`Service.Any` becomes the widened instance-side Service constraint used by public environment types. Constructor infrastructure remains available through `AnyServiceToken`, `Service.Token`, and `Service.Class`.

Public helpers operate naturally on instance types:

```ts
type Tag = Service.Tag<Database>
type Token = Service.TokenOf<Database>
type Requirements = Service.Requirements<UserRepository>
```

`Service.Instance<typeof Database>` may remain as the constructor-to-instance projection because it describes resolver infrastructure rather than environment representation.

Service method requirement extraction reads the instance-based `Effect.Requirements` of Effect-returning methods.

## Public Layer model

Layer provider APIs still receive constructors:

```ts
Layer.make(Database)
Layer.succeed(Database, fakeDatabase)
Layer.gen(UserRepository, factory)
Layer.scoped(Database, acquire, release)
```

Layer type metadata presents instances:

```ts
type Provided = Layer.Provided<typeof AppLive>
// Database | Logger

type Required = Layer.Required<typeof AppLive>
// Config

type Missing = Layer.Missing<typeof AppLive>
// Config
```

`LayerSpec<Provided, Required>` uses instance-side Service identities. Exact provider constructors remain recoverable through each provided instance's identity marker when override and collision logic needs the registering token.

Completeness uses:

1. literal tags recovered from instance identity;
2. bidirectionally compatible implementation contracts;
3. replacement ordering retained by exact Layer specs.

Same-tag, compatible replacements remain valid. Same-tag, incompatible replacements remain collisions. Different tags never satisfy one another, including for otherwise identical methods.

Runtime-facing `LayerRegistration.service` remains a `ServiceClass` constructor.

## Public Runtime model

A Runtime inferred from a Layer carries the instance environment:

```ts
const runtime = await Runtime.make(AppLive, backend)
// Runtime<Database | Logger>
```

Named boundaries retain the same representation:

```ts
type AppRuntime = Runtime.For<typeof AppLive>
// Runtime<Database | Logger>
```

Every execution boundary validates an Effect's instance requirement union against the Runtime's provided instance union. Tags are recovered from the phantom identities, so a same-shape Service under another tag does not satisfy the requirement.

Unparameterized Runtime annotations remain the intentional environment-erased escape hatch. Plain values, ordinary Results, Scope-only Effects, and requirement-free resource Effects remain executable in every Runtime.

Runtime resolution still calls the backend with the yielded constructor token. No runtime conversion from instance values is needed: all environment comparison happens at compile time.

## Missing-dependency diagnostics

Replace the current markers:

```text
__betterEffectMissingService__Database
__betterEffectMissingServices
__betterEffectMissingRuntimeService__Database
__betterEffectMissingRuntimeServices
```

with one named diagnostic abstraction:

```ts
declare const MissingDependenciesTypeId: unique symbol

type MissingDependencies<Missing extends AnyService> = {
  readonly [MissingDependenciesTypeId]: Missing
}
```

An incomplete Runtime execution should be reported through a parameter type equivalent to:

```ts
(() => Effect<User, UserError, Logger | Cache>) &
  MissingDependencies<Logger | Cache>
```

An incomplete Layer boundary should include:

```ts
Layer<...> & MissingDependencies<Database>
```

The TypeScript CLI controls final wording, but the principal named type identifies the missing instance union without internal-looking property names. A TypeScript 5.2.2 diagnostic spike confirmed that named generic diagnostic aliases appear in the primary assignability error.

`Layer.Missing<L>` remains the machine-readable inspection API and returns the missing instance union directly. `MissingDependencies` exists to shape boundary errors and is not added as a root application-facing export unless declaration generation requires public visibility.

## Identity and structural compatibility

### Different tags

```ts
class PrimaryDatabase extends Service<PrimaryDatabase>()('PrimaryDatabase') {
  query(): string {
    return 'primary'
  }
}

class ReplicaDatabase extends Service<ReplicaDatabase>()('ReplicaDatabase') {
  query(): string {
    return 'replica'
  }
}
```

The instance types are intentionally distinct because their hidden tags differ. A Runtime providing ReplicaDatabase cannot run an Effect requiring PrimaryDatabase.

This intentionally replaces the previous test contract that same-shape, different-tag instance types are exactly equal. That equality is incompatible with using `PrimaryDatabase` itself as a safe requirement identity.

### Same tag and compatible contract

Two Service constructors with the same literal tag and bidirectionally compatible instance contracts remain compatible for explicit Layer override semantics. Their instance identity payloads carry the same tag, and contract comparison ignores constructor names.

### Structural implementations

These paths remain valid:

```ts
const fake = Database.of({
  query: async () => user
})

const DatabaseTest = Layer.succeed(Database, {
  query: async () => user
})
```

Runtime checks remain defensive when unsafe or untyped values cross the public boundary.

## Relationship to Effect TS

The public signature resembles Effect TS:

```ts
Effect<User, UserError, Database | Logger>
```

The execution model does not. In better-effect this remains a `better-result` Result with phantom requirements. It is not a lazy instruction tree, fiber program, or Context-backed runtime value.

Documentation must state this distinction near the first public `Effect<A, E, R>` example to avoid implying unsupported semantics.

## Compatibility and migration

This change intentionally breaks public type annotations and type-level helpers.

Before:

```ts
type Program = EffectResult<User, UserError, typeof Database>
type RuntimeEnvironment = Runtime<typeof Database | typeof Logger>
type Provided = Layer.Provided<typeof AppLive>
// typeof Database | typeof Logger
```

After:

```ts
type Program = Effect<User, UserError, Database>
type RuntimeEnvironment = Runtime<Database | Logger>
type Provided = Layer.Provided<typeof AppLive>
// Database | Logger
```

Source and package tests, examples, README content, docs, and OpenSpec contracts must migrate together. The package release should treat the change according to the project's breaking-change policy.

The implementation should remove obsolete compatibility aliases when they only preserve the old token-based public model. Runtime token types remain public where consumers implement adapters or resolvers.

## Runtime behavior

No runtime behavior changes are intended:

- Effect values remain Results.
- `Effect.gen` continues to delegate to `Result.gen`.
- Service iterators continue to resolve through `ServiceRuntime`.
- Layer providers still register constructors with backends.
- Scope ownership and Runtime disposal remain unchanged.
- Requirement and identity markers remain declaration-only.
- No JavaScript namespace wrapper or phantom symbol value is emitted.

Generated-output tests must verify these properties.

## Testing strategy

### Service identity

Type tests must prove:

- `yield* Database` is exactly `Database`.
- `Service.Tag<Database>` is the literal tag.
- `Service.TokenOf<Database>` is the exact constructor token.
- same-shape, different-tag Service instances are incompatible;
- same-tag, compatible contracts retain override compatibility;
- `Service.of` accepts marker-free structural implementations;
- Layer creation accepts safe structural implementations;
- the marker emits no JavaScript.

### Effect types

Type tests must prove:

- inferred programs are `Effect<A, E, Database | Logger>`;
- `Effect.Requirements<T>` is the exact instance union;
- non-Service requirement types are rejected;
- `never` and intentional `any` erasure remain supported where designed;
- nested and pipeline composition unions all instance requirements;
- ordinary Results and Scope/resource-only Effects remain requirement-free;
- requirement covariance remains safe.

### Layer and Runtime

Type tests must prove:

- `Layer.Provided`, `Layer.Required`, and `Layer.Missing` return instance unions;
- `Runtime.make` and `Runtime.For` retain instance environments;
- complete executions compile;
- incomplete executions expose `MissingDependencies<Missing>`;
- incomplete Layers expose the same named diagnostic;
- multiple missing dependencies remain a precise union;
- different-tag compatible shapes do not satisfy one another;
- same-tag compatible overrides and incompatible collision diagnostics remain correct.

### Package declarations

Built-package fixtures must run with the current compiler and TypeScript 5.2.2 and verify:

- value/type/namespace coexistence for `Effect`;
- `Effect<A, E, R>` and namespaced helpers are importable;
- public instance environments are exact;
- invalid non-Service requirements fail;
- missing dependency diagnostics retain their name and missing instance union;
- declaration variance contracts remain intact;
- runtime JavaScript contains no type namespace or identity metadata.

### Runtime regression

Existing runtime tests must continue to pass unchanged in behavior. Focused tests should confirm that resolver and Layer backend calls still receive constructors rather than instance metadata.

## Documentation and specification updates

Update:

- package README examples and architecture language;
- Effects, Services, Layers, Runtime, testing, and introduction documentation;
- executable TODO example type annotations;
- main OpenSpec typed Layer and Runtime requirement contracts;
- project guidance that currently prohibits a public `Effect<A, E, R>`;
- statements saying Layer and Runtime retain constructor unions;
- comparison language clarifying that the new Effect type remains a Result facade.

Remove or rewrite examples that call an instance projection a canonical requirement, or that imply `Layer.Provided` returns constructors.

## Affected implementation areas

- `packages/better-effect/src/service/types.ts`
- `packages/better-effect/src/service/service.ts`
- `packages/better-effect/src/effect/types.ts`
- `packages/better-effect/src/effect/effect.ts`
- `packages/better-effect/src/effect/combinators.ts`
- `packages/better-effect/src/layer/types.ts`
- `packages/better-effect/src/layer/inference.ts`
- `packages/better-effect/src/layer/layer.ts`
- `packages/better-effect/src/layer/runtime.ts`
- `packages/better-effect/src/runtime/runtime.ts`
- public barrels and package exports
- source, package, variance, and declaration tests
- README, docs, examples, OpenSpec contracts, and project guidance

## Acceptance criteria

- A Database-and-Logger program is represented as `Effect<A, E, Database | Logger>`.
- Effect, Service, Layer, and Runtime public requirement/environment helpers expose instance unions.
- differently tagged Services remain distinct even when their implementation methods are identical.
- structural Service implementations remain accepted.
- Layer and Runtime boundaries identify unavailable instances through `MissingDependencies<...>`.
- resolver and backend APIs continue to use constructor tokens.
- Result, generator, Scope, Layer lifecycle, and Runtime behavior do not change.
- generated JavaScript contains no Service identity or Effect requirement metadata.
- all current and TypeScript 5.2.2 verification suites pass after migration.

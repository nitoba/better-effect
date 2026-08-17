# Instance Service Requirements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make public programs and environments read as `Effect<A, E, Database | Logger>` while retaining constructor tokens for runtime resolution and reporting unavailable Services as `MissingDependencies<...>`.

**Architecture:** Add a required declaration-only identity to Service instances and accept marker-free implementations through a top-level `ServiceContract` projection. Replace token-based public Effect, Layer, and Runtime environment metadata with tagged instance unions; retain exact constructors in a private LayerSpec channel for registration and override semantics. Keep all runtime behavior delegated to `better-result`, ServiceRuntime, Scope, and Layer backends.

**Tech Stack:** TypeScript 5.7+, Bun, better-result, bun:test, tsdown, Oxfmt, Oxlint, Turbo, OpenSpec markdown specifications.

**Design:** `docs/superpowers/specs/2026-08-16-instance-service-requirements-design.md`

---

## File structure

### Type-system implementation

- `packages/better-effect/src/service/types.ts` — instance identity, structural contract projection, canonical token extraction, Service requirement extraction.
- `packages/better-effect/src/service/service.ts` — recursive Service factory, structural `of`, and exact instance requirement yield.
- `packages/better-effect/src/effect/types.ts` — canonical `Effect<A, E, R>` and instance requirement inference.
- `packages/better-effect/src/effect/effect.ts` — Effect value/type/namespace merge.
- `packages/better-effect/src/effect/combinators.ts` — preserve and union instance environments.
- `packages/better-effect/src/internal/missing-dependencies.ts` — package-private named diagnostic contract.
- `packages/better-effect/src/layer/types.ts` — instance-facing LayerSpec plus exact constructor channel.
- `packages/better-effect/src/layer/inference.ts` — tagged instance compatibility, override, completeness, execution validation, and erasure rules.
- `packages/better-effect/src/layer/layer.ts` — structural provider signatures and public Layer namespace aliases.
- `packages/better-effect/src/layer/internal.ts` — structural generator return normalization.
- `packages/better-effect/src/layer/runtime.ts` — instance-parameterized RuntimeHandle.
- `packages/better-effect/src/runtime/runtime.ts` — instance-parameterized Runtime.
- `packages/better-effect/src/runtime/types.ts` — `Runtime.For`/`RuntimeFor` instance environment.
- `packages/better-effect/src/{effect,service,layer}/index.ts`, `packages/better-effect/src/index.ts` — public export migration.

### Type and package contracts

- Create `packages/better-effect/tests/types/instance-requirements.types.ts` — focused end-to-end contract for the new model.
- Update existing files under `packages/better-effect/tests/types/` that assert token-based requirements.
- Update `packages/better-effect/tests/package/public-type-namespaces/` — built public API and diagnostics.
- Update `packages/better-effect/tests/package/public-type-variance/` — built declaration variance and identity metadata.
- Create `packages/better-effect/tests/package/instance-requirements/` — exported subclass declaration emit and current/minimum compiler fixtures.
- Update `packages/better-effect/package.json` — package fixture scripts.

### Documentation and specifications

- `packages/better-effect/README.md`
- `apps/docs/content/docs/{index,effects,services,layers,runtime,testing,troubleshooting}.mdx`
- `packages/better-effect/examples/todo-api/**/*.ts`
- `openspec/specs/service-identity/spec.md`
- `openspec/specs/typed-layer-requirements/spec.md`
- `openspec/specs/typed-runtime-execution-requirements/spec.md`
- `AGENTS.md`

---

# Chunk 1: Establish the failing public contract

## Task 1: Add the end-to-end instance requirement type test

**Files:**

- Create: `packages/better-effect/tests/types/instance-requirements.types.ts`
- Reference: `docs/superpowers/specs/2026-08-16-instance-service-requirements-design.md`

- [ ] **Step 1: Establish a green baseline**

Run:

```bash
cd packages/better-effect
bun run typecheck
```

Expected: exit 0 before the new contract is created. If the baseline is not green, stop and diagnose it separately. Record the implementation base SHA for archive and review comparisons:

```bash
git rev-parse HEAD
```

Carry that value as `<implementation-base-sha>` throughout the plan.

- [ ] **Step 2: Write the failing type contract**

Create a focused test containing these declarations and assertions:

```ts
import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { Effect, type EffectRequirements } from '../../src/effect'
import { Layer, type LayerMissing, type LayerProvided } from '../../src/layer'
import { Runtime, type RuntimeFor } from '../../src/runtime'
import {
  Service,
  type ServiceIdentity,
  type ServiceTag,
  type ServiceToken,
  type ServiceTokenOf
} from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'database'
  }
}

class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}

class Cache extends Service<Cache>()('Cache') {
  get(): string {
    return 'cache'
  }
}

class Repository extends Service<Repository>()('Repository') {
  load() {
    return Effect.gen(async function* () {
      const database = yield* Database
      const logger = yield* Logger

      return Result.ok({ database, logger })
    })
  }
}

const program = Effect.gen(async function* () {
  const database = yield* Database
  const logger = yield* Logger

  return Result.ok({ database, logger })
})

type Program = Awaited<typeof program>

expectTypeOf<Program>().toEqualTypeOf<
  Effect<{ database: Database; logger: Logger }, never, Database | Logger>
>()
expectTypeOf<EffectRequirements<typeof program>>().toEqualTypeOf<Database | Logger>()
expectTypeOf<Effect.Requirements<typeof program>>().toEqualTypeOf<Database | Logger>()
expectTypeOf<Database>().toMatchTypeOf<ServiceIdentity<'Database'>>()
expectTypeOf<ServiceTag<Database>>().toEqualTypeOf<'Database'>()
expectTypeOf<ServiceTokenOf<Database>>().toEqualTypeOf<ServiceToken<'Database', Database>>()
expectTypeOf<ServiceTokenOf<Database | Logger>>().toEqualTypeOf<
  ServiceToken<'Database', Database> | ServiceToken<'Logger', Logger>
>()

const DatabaseLive = Layer.make(Database)
const LoggerLive = Layer.make(Logger)
const RepositoryLive = Layer.make(Repository)
const AppLive = Layer.merge(DatabaseLive, LoggerLive, RepositoryLive)

expectTypeOf<LayerProvided<typeof AppLive>>().toEqualTypeOf<Database | Logger | Repository>()
expectTypeOf<LayerMissing<typeof AppLive>>().toBeNever()
expectTypeOf<LayerMissing<typeof RepositoryLive>>().toEqualTypeOf<Database | Logger>()
expectTypeOf<RuntimeFor<typeof AppLive>>().toEqualTypeOf<Runtime<Database | Logger | Repository>>()

// @ts-expect-error arbitrary objects are not Service environments
type InvalidObjectEffect = Effect<string, Error, object>
// @ts-expect-error empty objects are not Service environments
type InvalidEmptyEffect = Effect<string, Error, {}>
// @ts-expect-error unknown is not a Service environment
type InvalidUnknownEffect = Effect<string, Error, unknown>

void ({} as Runtime<Database | Logger>).run(() => program)
// @ts-expect-error Logger is not provided
void ({} as Runtime<Database>).run(() => program)
```

Also include these exact erasure and generic contracts:

```ts
expectTypeOf<EffectRequirements<Effect.Any>>().toEqualTypeOf<Service.Any>()

declare const erasedEffect: Effect.Any
declare const explicitAnyEffect: Effect<unknown, never, any>

void ({} as Runtime<never>).run(() => erasedEffect)
void ({} as Runtime<never>).run(() => explicitAnyEffect)
void ({} as Runtime<any>).run(() => program)
void ({} as Runtime<Service.Any>).run(() => program)
void ({} as Runtime).run(() => program)

type RequirementFree = Effect<string, Error>
expectTypeOf<RequirementFree>().toEqualTypeOf<Effect<string, Error, never>>()
expectTypeOf<EffectRequirements<RequirementFree>>().toBeNever()

function runSame<R extends Service.Any>(runtime: Runtime<R>, effect: Effect<unknown, never, R>) {
  void runtime.run(() => effect)
}

function rejectUnrelated<R extends Service.Any>(
  runtime: Runtime<Database>,
  effect: Effect<unknown, never, R>
) {
  // @ts-expect-error R is not proven to be provided by Runtime<Database>
  void runtime.run(() => effect)
}
```

Use `.toBeNever()` for every new `never` assertion so the test remains valid with Bun's TypeScript 5.7 declarations.

- [ ] **Step 3: Run the test suite and verify RED**

Run:

```bash
cd packages/better-effect
bun run typecheck
```

Expected: non-zero exit because generic type `Effect<A, E, R>`, `ServiceIdentity`, `ServiceTokenOf`, and instance-based Layer/Runtime metadata do not exist yet. Require diagnostics from `instance-requirements.types.ts` involving a missing API, non-generic `Effect`, or token-versus-instance mismatch. Reject syntax errors and unexpected unused `@ts-expect-error` (`TS2578`). `expectTypeOf(...).toEqualTypeOf<...>()` may intentionally report a mismatch as `TS2554`; permit it only at the planned mismatch assertion lines and investigate unrelated `TS2554` diagnostics.

- [ ] **Step 4: Record the red-state scope**

Run:

```bash
git status --short -- packages/better-effect/tests/types/instance-requirements.types.ts
git diff --no-index -- /dev/null \
  packages/better-effect/tests/types/instance-requirements.types.ts || true
```

Expected: only the new contract test. Do not modify production code before the failing test has been observed.

---

# Chunk 2: Migrate the type-system core

Tasks 2–4 are one atomic RED→GREEN migration. The end-to-end contract from Chunk 1 intentionally remains red until Service, Effect, Layer, Runtime, and existing source tests have all migrated. Intermediate `typecheck` runs are diagnostic checkpoints only and must not be described as green. Do not commit the core separately; the first green implementation commit occurs after Chunk 3 has migrated built-package fixtures and all public declaration checks pass.

## Task 2: Add branded Service instances and structural implementation boundaries

**Files:**

- Modify: `packages/better-effect/src/service/types.ts`
- Modify: `packages/better-effect/src/service/service.ts`
- Modify: `packages/better-effect/src/service/index.ts`
- Modify: `packages/better-effect/src/index.ts`
- Modify: `packages/better-effect/src/layer/types.ts`
- Modify: `packages/better-effect/src/layer/layer.ts`
- Modify: `packages/better-effect/src/layer/internal.ts`
- Test: `packages/better-effect/tests/types/service.types.ts`
- Test: `packages/better-effect/tests/types/service-tagged-identity.types.ts`
- Test: `packages/better-effect/tests/types/service-identity.types.ts`
- Test: `packages/better-effect/tests/types/service-variance.types.ts`
- Test: `packages/better-effect/tests/types/layer.types.ts`
- Test: `packages/better-effect/tests/types/layer-scoped-gen.types.ts`
- Test: `packages/better-effect/tests/types/public-type-namespaces.types.ts`

- [ ] **Step 1: Extend the failing Service tests**

Before implementation, update Service-focused type tests to require:

```ts
expectTypeOf<Database>().toMatchTypeOf<ServiceIdentity<'Database'>>()
expectTypeOf<ServiceTag<Database>>().toEqualTypeOf<'Database'>()
expectTypeOf<ServiceTokenOf<Database>>().toEqualTypeOf<ServiceToken<'Database', Database>>()
expectTypeOf<ServiceContract<Database>>().toEqualTypeOf<{
  query(): string
}>()
```

Change the old same-shape/different-tag equality assertion to incompatibility:

```ts
expectTypeOf<EmptyPrimary>().not.toEqualTypeOf<EmptyReplica>()
```

Add same-tag classes with:

- different constructor parameters;
- different custom static members;
- a `self(): ThisService` method;
- a recursively nested `Promise<ThisService>` result.

Assert their `ServiceContract` shapes remain bidirectionally compatible when tags and behavior match.

Add marker-free structural acceptance tests for:

```ts
Database.of({ query: () => 'fake' })
Layer.make(Database, () => ({ query: () => 'fake' }))
Layer.succeed(Database, { query: () => 'fake' })
Layer.scoped(
  Database,
  () => ({ query: () => 'fake' }),
  (database) => database.query()
)
Layer.gen(Database, async function* () {
  return { query: () => 'fake' }
})
Layer.scopedGen(
  Database,
  async function* () {
    return { query: () => 'fake' }
  },
  (database) => database.query()
)
```

- [ ] **Step 2: Re-run and verify the expanded tests fail**

Run:

```bash
cd packages/better-effect
bun run typecheck
```

Expected: failures for missing identity/contract helpers, old instance equality, and structural inputs once the required marker is expected.

- [ ] **Step 3: Implement the Service instance identity**

In `src/service/types.ts`, add the declaration-only identity and widened instance constraint. The symbol is exported only between source modules; do not re-export it from `service/index.ts` or the package root:

```ts
export declare const ServiceIdentityTypeId: unique symbol

export interface ServiceIdentity<out Tag extends string = string> {
  readonly [ServiceIdentityTypeId]: Tag
}

export type AnyService = ServiceIdentity<string>

export type ServiceContract<S> = S extends unknown ? Omit<S, typeof ServiceIdentityTypeId> : never

export type ServiceTagOf<S extends AnyService> = S[typeof ServiceIdentityTypeId]

export type ServiceTokenOf<S extends AnyService> = S extends AnyService
  ? ServiceToken<ServiceTagOf<S>, S>
  : never
```

Treat `ServiceIdentityTypeId` as source-internal even though `service.ts` imports it: export `ServiceIdentity`, `AnyService`, `ServiceContract`, and `ServiceTokenOf` from the Service barrel and package root because consumer declaration emit must name `ServiceIdentity<Tag>`.

Change `ServiceTag<T>` to support the new instance spelling. Keep constructor infrastructure helpers (`AnyServiceToken`, `ServiceToken`, `ServiceClass`, `ServiceInstance`) intact for resolvers and adapters.

Migrate the currently token-oriented method helper in the same atomic cycle:

```ts
export type ServiceRequirements<S extends AnyService> = MethodRequirements<S>
```

and make `Service.Requirements<S extends Service.Any>` delegate to it. Layer call sites become `ServiceRequirements<InstanceType<S>>`.

Change `ServiceStatics.of` to consume the marker-free contract while returning the branded instance. Preserve function-property syntax and invariance:

```ts
readonly of: (
  this: void,
  implementation: ServiceContract<Instance>
) => Instance
```

If the recursive base needs the known tag bridge, use `ServiceContract<Self & ServiceIdentity<Tag>>` in the factory-specific signature as specified by the design.

- [ ] **Step 4: Implement the recursive Service factory safely**

In `src/service/service.ts`:

- import `ServiceIdentityTypeId` from `./types` without exposing it through a barrel;
- make the base constructor instance side `ServiceIdentity<Tag>`;
- add `declare readonly [ServiceIdentityTypeId]: Tag` to `BaseService`;
- do not constrain outer `Self` to `AnyService`;
- avoid conflicting `of` signatures by omitting `of` from any picked `ServiceToken` statics before adding the recursive factory-specific signature;
- use this factory return core:

```ts
(abstract new () => ServiceIdentity<Tag>) & {
  readonly of: (
    this: void,
    implementation: ServiceContract<Self & ServiceIdentity<Tag>>
  ) => Self

  readonly [Symbol.asyncIterator]: (
    this: ServiceToken<Tag, Self>
  ) => AsyncGenerator<ServiceRequirement<Self>, Self, unknown>
}
```

- keep the iterator non-generic and exact:

```ts
readonly [Symbol.asyncIterator]: (
  this: ServiceToken<Tag, Self>
) => AsyncGenerator<ServiceRequirement<Self>, Self, unknown>
```

Implement `of` with one localized cast from the marker-free contract to `Self`. Keep runtime resolution unchanged:

```ts
return await ServiceRuntime.resolve(this)
```

Expose namespace aliases:

```ts
Service.Any
Service.Identity<Tag>
Service.Contract<S>
Service.TokenOf<S>
```

- [ ] **Step 5: Adapt all structural Layer provider inputs**

Without changing Layer requirement semantics yet, update public provider boundaries explicitly:

```ts
acquire: () => MaybePromise<ServiceContract<InstanceType<S>>>
instance: ServiceContract<InstanceType<S>>
LayerGenerator return: ServiceContract<InstanceType<S>>
```

Normalize to `InstanceType<S>` at the internal erasure boundary. Release callbacks must still receive branded `InstanceType<S>`.

Update `LayerGenerator` and `runLayerGenerator` so generator returns may be marker-free contracts while stored/resolved values are branded Service instances.

Keep casts localized in `layer.ts`/`layer/internal.ts`; do not add runtime markers.

- [ ] **Step 6: Run focused typechecking**

Run:

```bash
cd packages/better-effect
bun run typecheck
```

Expected: still non-zero because the atomic migration is incomplete. Inspect diagnostics and require that new Service identity/structural signatures no longer produce errors; remaining failures must be attributable to not-yet-migrated Effect/Layer/Runtime metadata or existing tests. This is not a GREEN checkpoint.

## Task 3: Replace EffectResult with Effect<A, E, R>

**Files:**

- Modify: `packages/better-effect/src/effect/types.ts`
- Modify: `packages/better-effect/src/effect/effect.ts`
- Modify: `packages/better-effect/src/effect/combinators.ts`
- Modify: `packages/better-effect/src/effect/index.ts`
- Modify: `packages/better-effect/src/index.ts`
- Test: `packages/better-effect/tests/types/effect.types.ts`
- Test: `packages/better-effect/tests/types/pipeline.types.ts`
- Test: `packages/better-effect/tests/types/scope.types.ts`
- Test: `packages/better-effect/tests/types/effect-add-disposable.types.ts`
- Test: `packages/better-effect/tests/types/layer-variance.types.ts`
- Test: `packages/better-effect/tests/types/public-type-namespaces.types.ts`

- [ ] **Step 1: Migrate Effect expectations before production code**

Replace token assertions with exact instance unions, for example:

```ts
expectTypeOf<EffectRequirements<typeof program>>().toEqualTypeOf<Database | Cache>()
expectTypeOf<Awaited<typeof program>>().toEqualTypeOf<
  Effect<{ database: Database; cache: Cache }, never, Database | Cache>
>()
```

Replace explicit `EffectResult` declarations with `Effect<A, E, R>`. Add rejection tests for `{}`, `object`, primitives, arbitrary interfaces, and `unknown`; retain `never`, `Effect.Any`, and explicit `any` erasure tests.

Update pipeline expectations to:

```ts
Effect<B, E1 | E2, Database | Cache>
```

- [ ] **Step 2: Run typecheck and verify RED**

Run:

```bash
cd packages/better-effect
bun run typecheck
```

Expected: failures because `Effect` is not yet a generic type and generator/combinator requirements remain tokens.

- [ ] **Step 3: Implement the canonical Effect type**

In `src/effect/types.ts`, replace `EffectResult`/`AnyEffectResult` with:

```ts
export type Effect<A, E, R extends AnyService = never> = ResultType<A, E> & {
  readonly [EffectRequirementsTypeId]?: R
}

export type AnyEffect = Effect<unknown, unknown, AnyService>
```

Keep the metadata property optional and readonly for covariance and ordinary Result compatibility.

Make `ServiceRequirement<T>` unconstrained and covariant so recursive `Self` is nameable. Filter extracted requirements:

```ts
export type InferYieldRequirements<Y> =
  Y extends ServiceRequirement<infer Requirement>
    ? Requirement extends AnyService
      ? Requirement
      : never
    : never
```

Make `EffectRequirements<T>` presence-aware and distributive, returning only valid instance environments. Keep ordinary Results at `never` and Promise-wrapped Effects precise.

Update `EffectFromGenerator` to return `Effect<...>` and union direct/returned instance requirements.

- [ ] **Step 4: Merge the Effect value, type, and namespace**

In `src/effect/effect.ts`, place the type alias in the same module as the value and namespace so barrel exports merge correctly:

```ts
import type { Effect as EffectType } from './types'
import type { AnyService } from '../service'

export type Effect<A, E, R extends AnyService = never> = EffectType<A, E, R>

export const Effect = {/* unchanged runtime value */} as const
```

Barrels export the merged `Effect` from `effect.ts` once; they must not separately re-export a conflicting same-named alias from `types.ts`. Update the namespace:

```ts
export declare namespace Effect {
  export type Success<T> = EffectSuccess<T>
  export type Error<T> = EffectError<T>
  export type Requirements<T> = EffectRequirements<T>
  export type Any = AnyEffect
}
```

Do not emit a namespace IIFE or runtime assignments.

Remove `EffectResult`, `AnyEffectResult`, and `Effect.AnyResult` from source/package exports and tests.

- [ ] **Step 5: Migrate combinators**

Constrain requirement generics to `AnyService` and replace every `EffectResult` construction/cast with `Effect`. Preserve async shape and union requirements exactly:

```ts
type ChainedResult<First, Next> = Effect<
  EffectSuccess<Next>,
  EffectError<First> | EffectError<Next>,
  EffectRequirements<First> | EffectRequirements<Next>
>
```

Continue delegating runtime behavior to `better-result`; add no metadata writes.

- [ ] **Step 6: Re-run focused tests**

Run:

```bash
cd packages/better-effect
bun run typecheck
bun test tests/effect.test.ts tests/pipeline.test.ts tests/service.test.ts
```

Expected: Effect/Service/pipeline contracts pass. Layer/Runtime token expectation failures may remain until Task 4, but no runtime test should regress.

## Task 4: Migrate Layer and Runtime environments and diagnostics

**Files:**

- Create: `packages/better-effect/src/internal/missing-dependencies.ts`
- Modify: `packages/better-effect/src/layer/types.ts`
- Modify: `packages/better-effect/src/layer/inference.ts`
- Modify: `packages/better-effect/src/layer/layer.ts`
- Modify: `packages/better-effect/src/layer/runtime.ts`
- Modify: `packages/better-effect/src/runtime/runtime.ts`
- Modify: `packages/better-effect/src/runtime/types.ts`
- Modify: `packages/better-effect/src/layer/index.ts`
- Test: `packages/better-effect/tests/types/layer.types.ts`
- Test: `packages/better-effect/tests/types/layer-scoped-gen.types.ts`
- Test: `packages/better-effect/tests/types/layer-variance.types.ts`
- Test: `packages/better-effect/tests/types/runtime.types.ts`
- Test: `packages/better-effect/tests/types/service-identity.types.ts`
- Test: `packages/better-effect/tests/layer-runtime.test.ts`

- [ ] **Step 1: Migrate Layer/Runtime tests to the desired instance model**

Change exact expectations:

```ts
LayerProvided<typeof AppLive> // Database | Logger
LayerRawRequired<typeof RepositoryLive> // Database
LayerMissing<typeof Broken> // Database | PasswordHasher
Runtime<Database | Logger>
RuntimeHandle<Database | Logger>
ExecutionMissing<Database, Program> // Logger
```

Replace old underscored diagnostic shape assertions with `MissingDependencies<...>` match assertions through source-internal imports in source tests only.

Add erasure equations:

```ts
ExecutionMissing<Database, Effect.Any> // never
ExecutionMissing<Service.Any, Effect<Value, Error, Database>> // never
ExecutionMissing<Database, Effect<Value, Error, any>> // never
```

Add same-tag override tests where constructors differ in parameters/statics and contracts contain self-returning values.

- [ ] **Step 2: Run typecheck and verify RED**

Run:

```bash
cd packages/better-effect
bun run typecheck
```

Expected: token-versus-instance failures in LayerSpec, Layer inference, Runtime, and missing diagnostics.

- [ ] **Step 3: Add the package-private diagnostic type**

Create `src/internal/missing-dependencies.ts`:

```ts
declare const MissingDependenciesTypeId: unique symbol

export type MissingDependencies<Missing extends AnyService> = {
  readonly [MissingDependenciesTypeId]: Missing
}
```

Do not export it from a package barrel. It must remain nameable in bundled declarations because public signatures reference it.

- [ ] **Step 4: Add the exact constructor channel to LayerSpec**

Change LayerSpec to the normative shape:

```ts
export type LayerSpec<
  out Provided extends AnyService,
  out Required extends AnyService = never,
  out Token extends AnyServiceToken = ServiceTokenOf<Provided>
> = {
  readonly provided: Provided
  readonly required: Required
  readonly token: Token
}
```

If the token field must be phantom rather than an ordinary structural property, use a declaration-only unique-symbol field in the type. Do not add a runtime provider field solely for type metadata.

Every Layer constructor returns:

```ts
Layer<LayerSpec<InstanceType<S>, ServiceRequirements<InstanceType<S>> | GeneratorRequirements, S>>
```

Preserve exact `S` through merge/override. Compare only `Provided`/`Required` contracts; never compare static constructor shape for compatibility.

- [ ] **Step 5: Rewrite Layer inference around tagged instances**

Implement distributive helpers for:

- provided instance extraction;
- required instance extraction;
- exact token extraction;
- `ServiceTagOf<Instance>`;
- bidirectional `ServiceContract<Left>`/`ServiceContract<Right>` compatibility;
- `IsAny` and widened-tag erasure sentinels;
- missing requirement distribution;
- override replacement and collision tracking.

Define two separate mechanisms:

1. **Override/collision matching:** bidirectional exact literal-tag equality plus bidirectional `ServiceContract` compatibility. Never treat widened `Service.Any` as a replacement candidate.
2. **Missing/completeness/execution matching:** handle `any` and widened-tag erasure sentinels first, then perform concrete distributive pairwise matching.

Prove these equations in source tests:

```ts
MissingServices<any, Database> // never
MissingServices<Database, any> // never
MissingServices<Service.Any, Database> // never
MissingServices<Database, Service.Any> // never
MissingServices<R, R> // never, R extends Service.Any
MissingServices<Logger, Database> // Logger
```

Override replacement compares only `Provided` instances and retains the complete winning LayerSpec, including exact `Token`. Incompatible collisions compare instance contracts but retain the replacement spec's exact constructor channel for constructor diagnostics.

Replace complete Layer and execution diagnostics with intersections containing `MissingDependencies<Missing>`.

- [ ] **Step 6: Parameterize RuntimeHandle and Runtime with instances**

Change defaults and construction results:

```ts
RuntimeHandle<Provided extends AnyService = any>
Runtime<Provided extends AnyService = any>
Runtime.make(...) // Runtime<LayerProvided<L>>
Runtime.For<L> // Runtime<Layer.Provided<L>>
```

Keep backend and ServiceRuntime APIs token-based. No runtime conversion or identity lookup should be added.

- [ ] **Step 7: Add runtime-neutrality regressions**

In `tests/layer-runtime.test.ts`, assert with a recording backend that:

- `LayerRegistration.service === Database`;
- an override registers the winning exact constructor;
- yielding `Database` causes `resolve` to receive the `Database` constructor;
- resolved instances have no emitted Service identity symbol/property.

Run:

```bash
cd packages/better-effect
bun test tests/layer-runtime.test.ts tests/service.test.ts
```

Expected: runtime behavior passes without metadata.

- [ ] **Step 8: Run the complete source verification**

Run:

```bash
cd packages/better-effect
bun run typecheck
bun test
```

Expected: zero source TypeScript errors and all runtime tests pass. This is source-green only; built-package contracts remain red until Chunk 3. Do not weaken identity or erasure checks to silence tests.

- [ ] **Step 9: Inspect runtime output invariance**

Run:

```bash
cd packages/better-effect
bun run build
if rg "ServiceIdentityTypeId|EffectRequirementsTypeId|MissingDependenciesTypeId" \
  dist -g '*.mjs'
then
  echo "Unexpected runtime type metadata"
  exit 1
fi
```

Expected: build succeeds and no runtime JavaScript metadata is found.

Do not commit yet. Existing built-package fixtures still target `EffectResult`; Chunk 3 must migrate and verify them before the first green implementation commit.

---

# Chunk 3: Harden built-package contracts and diagnostics

## Task 5: Add current and minimum-compiler package fixtures

**Files:**

- Create: `packages/better-effect/tests/package/instance-requirements/exported-service.ts`
- Create: `packages/better-effect/tests/package/instance-requirements/valid.ts`
- Create: `packages/better-effect/tests/package/instance-requirements/invalid-environment.ts`
- Create: `packages/better-effect/tests/package/instance-requirements/invalid-runtime.ts`
- Create: `packages/better-effect/tests/package/instance-requirements/invalid-layer.ts`
- Create: `packages/better-effect/tests/package/instance-requirements/tsconfig.json`
- Create: `packages/better-effect/tests/package/instance-requirements/tsconfig.emit.json`
- Create: `packages/better-effect/tests/package/instance-requirements/tsconfig.invalid-environment.json`
- Create: `packages/better-effect/tests/package/instance-requirements/tsconfig.invalid-runtime.json`
- Create: `packages/better-effect/tests/package/instance-requirements/tsconfig.invalid-layer.json`
- Create: `packages/better-effect/tests/package/instance-requirements/check.ts`
- Modify: `packages/better-effect/tests/package/public-type-namespaces/valid.ts`
- Modify: `packages/better-effect/tests/package/public-type-namespaces/check.ts`
- Modify: `packages/better-effect/tests/package/public-type-namespaces/invalid-runtime.ts`
- Modify: `packages/better-effect/tests/package/public-type-variance/valid.ts`
- Modify: `packages/better-effect/tests/package/public-type-variance/check.ts`
- Modify: `packages/better-effect/package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write failing dist-consumer fixtures**

Put exported subclasses in `exported-service.ts` and import them from `valid.ts`:

```ts
export class Database extends Service<Database>()('Database') {
  query(): string {
    return 'ok'
  }
}

export class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}
```

In `valid.ts`, import from bare `better-effect` and prove:

```ts
declare const program: Effect<string, Error, Database | Logger>

type Requirements = Expect<Equal<Effect.Requirements<typeof program>, Database | Logger>>
type Token = Expect<Equal<Service.TokenOf<Database>, Service.Token<'Database', Database>>>
```

Also cover default `Runtime`, `Runtime<any>`, `Runtime<Service.Any>`, `Effect.Any`, generic same-environment execution, Layer erasure, and resolver `T -> InstanceType<T>`.

In `invalid-environment.ts`, declare five invalid Effect aliases—`{}`, `object`, `unknown`, a named random interface, and a primitive—without `@ts-expect-error`. Give each declaration a unique name so the checker can verify that all five diagnostics occurred.

In `invalid-runtime.ts`, run `Effect<..., Logger | Cache>` in `Runtime<Database>`. In `invalid-layer.ts`, pass a Layer missing Database to a complete Runtime boundary. Their combined compiler output must contain, respectively:

```text
MissingDependencies<Logger | Cache>
MissingDependencies<Database>
```

- [ ] **Step 2: Run fixtures and verify RED with the actual project compiler**

Run:

```bash
cd packages/better-effect
bun run build
bun run --silent tsc -- -p tests/package/instance-requirements/tsconfig.json --pretty false
```

Expected: failure before the built API and fixtures are migrated. Do not use unpinned `bunx tsc`; it can resolve a compiler different from the project's compiler. Minimum checks must use exactly:

```bash
bunx --bun --package typescript@5.7.2 tsc
```

- [ ] **Step 3: Add declaration-emission configs**

`tsconfig.emit.json` must include `exported-service.ts`, set `declaration: true`, `emitDeclarationOnly: true`, and override `noEmit: false`. The checker emits to separate ignored directories:

```text
tests/package/instance-requirements/out/current
tests/package/instance-requirements/out/ts5.7
```

Emit with the project compiler and TypeScript 5.7.2, inspect both declarations for `ServiceIdentity<"Database">`, reject TS4020, and then typecheck the emitted declaration entry points. Remove both output directories in a `finally` path.

- [ ] **Step 4: Migrate namespace and variance fixtures semantically**

Use the new alias families:

```ts
Effect: ['Success', 'Error', 'Requirements', 'Any']
Service: [
  'Any',
  'Identity',
  'Token',
  'Class',
  'Instance',
  'Tag',
  'TokenOf',
  'Contract',
  'Requirements'
]
```

Prove:

- `Effect.Any`, not `Effect.AnyResult`;
- `Service.Any = AnyService`, not `AnyServiceToken`;
- instance arguments for `Service.Tag` and `Service.Requirements`;
- `Service.Identity`, `Service.Contract`, and `Service.TokenOf` aliases;
- stale `EffectResult`, `AnyEffectResult`, and `Effect.AnyResult` names are absent from the built declaration graph;
- instance-based Effect covariance;
- unconstrained covariant `ServiceRequirement`;
- required `ServiceIdentity` plus marker-free `ServiceContract`;
- all three LayerSpec channels, including exact token metadata;
- recursive/self-returning Service contract compatibility;
- default/any/generic Runtime erasure and resolver relationships.

Replace the old underscored Runtime diagnostic assertion with `MissingDependencies<Cache>`.

- [ ] **Step 5: Implement the package checker**

Use `Bun.spawnSync`. For every compiler invocation:

- pass `--pretty false`;
- decode `stdout + stderr` because TypeScript may report diagnostics on stdout;
- require expected success/non-zero exit explicitly.

Run valid, invalid-environment, invalid-runtime, and invalid-layer configs under both the project compiler and TypeScript 5.7.2. For invalid environments, assert all five uniquely named aliases/types appear with the intended Service constraint diagnostic. For Runtime/Layer diagnostics, use whitespace-tolerant matching that proves both the `MissingDependencies` name and precise missing union.

Scan every generated `.mjs` chunk and reject:

```text
ServiceIdentityTypeId
EffectRequirementsTypeId
MissingDependenciesTypeId
```

Preserve existing stronger checks for namespace assignments/IIFEs, runtime own properties for type aliases, Service reflection, and Layer phantom symbol leakage.

Update the existing namespace checker so its current-compiler child process also uses the project compiler rather than `['bun', 'x', 'tsc', ...]`.

- [ ] **Step 6: Wire package scripts and CI**

Add:

```json
{
  "check:instance-requirements": "bun tests/package/instance-requirements/check.ts"
}
```

Include it in package `check` after build and before publint. Add the corresponding post-build package check to `.github/workflows/ci.yml`, because CI currently calls declaration checks individually rather than package `check`.

- [ ] **Step 7: Run the full first GREEN verification**

Run:

```bash
cd packages/better-effect
bun run format
bun run typecheck
bun test
bun run build
bun run check:public-type-namespaces
bun run check:public-type-variance
bun run check:instance-requirements
bun run lint
```

Expected: all source and built-package checks pass; intentional invalid fixtures fail only inside their checker and produce the asserted diagnostics.

- [ ] **Step 8: Commit the complete implementation and package contracts**

Stage only the reviewed implementation, source tests, package fixtures, package script, and CI workflow:

```bash
git add \
  packages/better-effect/src \
  packages/better-effect/tests/types \
  packages/better-effect/tests/package \
  packages/better-effect/tests/*.test.ts \
  packages/better-effect/package.json \
  .github/workflows/ci.yml
git commit -m "feat: use instance service requirements"
```

---

# Chunk 4: Migrate documentation, examples, and specifications

## Task 6: Update public documentation and executable examples

**Files:**

- Modify: `packages/better-effect/README.md`
- Modify: `apps/docs/content/docs/index.mdx`
- Modify: `apps/docs/content/docs/effects.mdx`
- Modify: `apps/docs/content/docs/services.mdx`
- Modify: `apps/docs/content/docs/layers.mdx`
- Modify: `apps/docs/content/docs/runtime.mdx`
- Modify: `apps/docs/content/docs/testing.mdx`
- Modify: `apps/docs/content/docs/troubleshooting.mdx`
- Modify: `packages/better-effect/examples/todo-api/**/*.ts` where environment types appear

- [ ] **Step 1: Update the primary README model**

Show an actually inferred shape near the first Effect example:

```ts
type LoadUser = Awaited<typeof loadUser>
// Effect<User, UserError, Database | Logger>
```

When showing `type LoadUser = Effect<...>` directly, call it a canonical annotation rather than inferred output.

State immediately:

- this is a type-only `better-result` Result facade;
- it is not an Effect TS instruction tree;
- constructors remain resolver/Layer handles;
- `Effect.Requirements`, `Layer.Provided`, `Layer.Missing`, and `Runtime.For` expose instance unions.

Replace token-union public environment examples and remove `EffectResult` compatibility language. Explain the new Service identity boundary in README and `services.mdx`:

- `ServiceIdentity<Tag>` is required but declaration-only;
- no identity property exists at runtime;
- `Service.Contract<Database>` is the marker-free implementation shape;
- `Service.of` and every Layer provider API accept structural contracts and return/provide the branded Service type.

- [ ] **Step 2: Update docs by concept**

Use these exact conceptual outputs:

```ts
Effect.Requirements<Program> // Database | Logger
Service.Tag<Database> // 'Database'
Service.TokenOf<Database> // Service.Token<'Database', Database>
Layer.Provided<typeof AppLive> // Database | Logger
Layer.Missing<typeof Broken> // Logger
Runtime.For<typeof AppLive> // Runtime<Database | Logger>
```

In troubleshooting, show a missing dependency error containing:

```ts
MissingDependencies<Logger | Cache>
```

Remove references to underscored diagnostics and token-based public requirements.

- [ ] **Step 3: Update the TODO example**

Replace Runtime/environment annotations with instance unions or `Runtime.For<typeof AppLive>`. Do not move business logic or DI responsibilities.

Run:

```bash
cd packages/better-effect
bun run typecheck:example
```

Expected: example compiles with no explicit constructor-union environment annotation.

- [ ] **Step 4: Build docs**

Run from repository root:

```bash
bun run docs:build
```

Expected: docs build succeeds with no invalid imports or MDX errors. This command does not typecheck TypeScript code fences. Reconcile every changed public snippet against `packages/better-effect/tests/package/instance-requirements/valid.ts` (or add the representative snippet there) before claiming snippet correctness.

## Task 7: Update normative project and OpenSpec contracts

**Files:**

- Modify: `AGENTS.md`
- Modify: `openspec/specs/service-identity/spec.md`
- Modify: `openspec/specs/typed-layer-requirements/spec.md`
- Modify: `openspec/specs/typed-runtime-execution-requirements/spec.md`

- [ ] **Step 1: Update project invariants**

Revise only the invariants superseded by this approved architecture:

- public Effect requirements are tagged Service instance unions;
- Service constructors remain runtime tokens;
- identity is a required declaration-only instance marker;
- structural implementations pass through `ServiceContract` boundaries;
- Layer/Runtime public environment generics use instances;
- `Effect<A, E, R>` remains a Result facade, not a runtime Effect abstraction;
- missing boundaries use `MissingDependencies<...>`.

Do not weaken Scope, Resource, resolver, adapter, Layer override, or lifecycle invariants.

- [ ] **Step 2: Rewrite the affected main OpenSpec contracts completely**

Do not edit archived changes. Update Purpose text, requirement prose, scenario names, and examples—not only code snippets—in all three main specs. Remove constructor-contract requirements and underscored diagnostic wording before adding:

```text
Effect<A, E, Database | Logger>
Layer.Missing<L> = Database | Logger
Runtime<Database | Logger>
MissingDependencies<Logger>
```

Preserve scenarios for:

- same-shape/different-tag rejection;
- same-tag/bidirectionally-compatible override;
- exact resolver constructor-to-instance relationship;
- requirement-free Scope/resource programs.

Before implementation, record the implementation base SHA from the final design/plan commit. Verify archives against that recorded SHA and against both index/worktree state:

```bash
git diff --exit-code <implementation-base-sha>..HEAD -- openspec/changes/archive
git diff --cached --exit-code -- openspec/changes/archive
git diff --exit-code -- openspec/changes/archive
```

Validate main specs:

```bash
command -v openspec
openspec validate --all
```

Expected: the CLI exists and validation succeeds. The current workstation did not expose `openspec` during design exploration; if it remains unavailable, stop and ask the user to provision the project-required CLI rather than silently claiming OpenSpec validation.

- [ ] **Step 3: Search for stale normative statements**

Run a strict forbidden-pattern check:

```bash
TARGETS="AGENTS.md packages/better-effect/README.md apps/docs/content/docs openspec/specs packages/better-effect/examples"
if rg "EffectResult|AnyEffectResult|__betterEffectMissing|Service\\.Tag<typeof|Service\\.Requirements<typeof|typeof Database \\| typeof Logger|provided tagged Service-constructor union|Service-token union|Service constructor union|no public .*Effect<A, E, R>" $TARGETS
then
  echo "Stale public requirement model found"
  exit 1
fi
```

Then perform a broader manual audit:

```bash
rg "ServiceToken|typeof [A-Z]|Service token|Service-token|constructor union|Runtime<.*typeof" $TARGETS
```

Expected: every remaining match is manually justified as resolver/backend/runtime-constructor infrastructure, not a public environment or Effect requirement.

- [ ] **Step 4: Commit docs and specs**

Stage only the explicitly reviewed files:

```bash
git add \
  AGENTS.md \
  openspec/specs/service-identity/spec.md \
  openspec/specs/typed-layer-requirements/spec.md \
  openspec/specs/typed-runtime-execution-requirements/spec.md \
  packages/better-effect/README.md \
  apps/docs/content/docs/index.mdx \
  apps/docs/content/docs/effects.mdx \
  apps/docs/content/docs/services.mdx \
  apps/docs/content/docs/layers.mdx \
  apps/docs/content/docs/runtime.mdx \
  apps/docs/content/docs/testing.mdx \
  apps/docs/content/docs/troubleshooting.mdx
# Add only the individually reviewed TODO example files reported by git status.
git commit -m "docs: describe instance service environments"
```

## Task 8: Final verification and review

**Files:**

- Verify all modified files
- Reference: `docs/superpowers/specs/2026-08-16-instance-service-requirements-design.md`

- [ ] **Step 1: Run formatting, inspect, and commit the review candidate**

Run:

```bash
bun run format
git diff --check
git status --short
```

Expected: formatter completes, no whitespace errors, and only intended files are modified. If formatting changed files, inspect `git status`, stage each formatter-modified path individually from the reviewed file lists above (never `git add -A` or a whole directory), then commit:

```bash
git commit -m "chore: format instance requirement migration"
```

Capture the candidate HEAD only after all implementation/docs/format changes are committed.

- [ ] **Step 2: Run the full required verification**

Run from repository root:

```bash
bun run check
```

Expected: Turbo reports successful typecheck, tests, formatting, build, package declaration checks, publint, and lint for every affected workspace.

- [ ] **Step 3: Re-run the original acceptance examples explicitly**

Run:

```bash
cd packages/better-effect
bun run typecheck
bun run check:instance-requirements
```

Confirm from the fixtures:

- `Effect<A, E, Database | Logger>` is exact;
- invalid non-Service environments fail;
- missing Runtime/Layer dependencies show `MissingDependencies<...>`;
- exported Service subclass declarations compile on TypeScript 5.7.2;
- runtime JavaScript contains no phantom metadata.

- [ ] **Step 4: Request code review**

Dispatch a reviewer with:

- design: `docs/superpowers/specs/2026-08-16-instance-service-requirements-design.md`;
- implementation plan: this file;
- base SHA before implementation;
- final HEAD SHA;
- explicit attention to TypeScript 5.7 recursive types, erasure sentinels, Layer override compatibility, declaration output, diagnostics, runtime neutrality, README/docs accuracy, main OpenSpec consistency, AGENTS invariants, archive immutability, and stale-search results.

Fix every Critical or Important issue. Stage only reviewed paths, commit fixes, capture the new HEAD, rerun `bun run check`, and request follow-up review against the updated commit.

- [ ] **Step 5: Verify the final reviewed tree**

After review approval and the fresh full check, run:

```bash
git diff --check
git status --short
git diff --exit-code <implementation-base-sha>..HEAD -- openspec/changes/archive
git diff --cached --exit-code -- openspec/changes/archive
git diff --exit-code -- openspec/changes/archive
```

Expected: no whitespace errors, no unintended/uncommitted files, and unchanged OpenSpec archives.

---

## Completion checklist

- [ ] Every production change was preceded by a failing type/runtime/package test.
- [ ] `EffectResult` and `AnyEffectResult` are absent from public exports.
- [ ] `Effect<A, E, R>` is a type-only Result facade.
- [ ] Public requirements/environments are Service instances.
- [ ] Runtime resolver/backend contracts still use constructors.
- [ ] Structural Service implementations remain supported at all documented boundaries.
- [ ] Different concrete tags never satisfy each other.
- [ ] Same-tag compatible overrides ignore static constructor differences.
- [ ] `MissingDependencies<...>` remains package-private and appears in built-package Runtime/Layer diagnostics.
- [ ] Current and TypeScript 5.7.2 declaration fixtures pass.
- [ ] No phantom metadata exists in generated JavaScript.
- [ ] README, docs, examples, OpenSpec specs, and AGENTS.md agree.
- [ ] Docs build and executable example typecheck pass.
- [ ] OpenSpec validation passes and archived changes are untouched.
- [ ] The final committed HEAD has no Critical/Important review findings.
- [ ] `bun run check` exits successfully.
- [ ] `git diff --check` and final status confirm a clean intended tree.

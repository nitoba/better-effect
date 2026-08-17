# Public Type Variance Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Service instance-contract widening and Layer provider-metadata widening without adding runtime behavior.

**Architecture:** Add internal structural variance helpers, carry an internal unique-symbol Service marker through `ServiceStatics`, and replace Layer's covariant phantom fields with an invariant/covariant variance marker. Preserve the public runtime representation, then verify source assignability and built declarations with the current compiler and TypeScript 5.2.2.

**Tech Stack:** TypeScript 5.2+, Bun, `bun:test` type assertions, tsdown declaration bundling, Oxfmt, Oxlint.

**Spec:** `docs/superpowers/specs/2026-08-16-public-type-variance-hardening-design.md`

**Implementation prerequisite:** Commit this plan before editing source with the exact message `docs: plan public type variance hardening`. Final verification uses that commit as the implementation-range anchor.

---

## File Map

### New files

- `packages/better-effect/src/internal/variance.ts` — internal type-only `Covariant` and `Invariant` helpers.
- `packages/better-effect/tests/types/service-variance.types.ts` — source-level Service assignability contract.
- `packages/better-effect/tests/types/layer-variance.types.ts` — source-level Layer and covariant metadata contract.
- `packages/better-effect/tests/package/public-type-variance/valid.ts` — built-package assignability fixture using only package-root imports.
- `packages/better-effect/tests/package/public-type-variance/tsconfig.json` — ambient-free consumer configuration compatible with TypeScript 5.2.2.
- `packages/better-effect/tests/package/public-type-variance/check.ts` — declaration-graph and runtime-erasure assertions.

### Modified files

- `packages/better-effect/src/service/types.ts` — define the hidden Service marker and invariant `ServiceStatics` contract.
- `packages/better-effect/src/service/service.ts` — declare the marker on classes produced by `Service()`.
- `packages/better-effect/src/layer/layer.ts` — make exact Layer Specs invariant, adjust invariant factory signatures, and keep collisions covariant.
- `packages/better-effect/src/layer/inference.ts` — make `Layer.Any` universal for `never` Specs and preserve exact extraction.
- `packages/better-effect/src/layer/types.ts` — declare `LayerSpec` covariance.
- `packages/better-effect/src/effect/types.ts` — declare `ServiceRequirement` covariance.
- `packages/better-effect/tests/types/public-type-namespaces.types.ts` — update `Layer.Any` equality to its universal union.
- `packages/better-effect/tests/package/public-type-namespaces/valid.ts` — update the built namespace equality contract.
- `packages/better-effect/package.json` — add built-package variance checks to the package verification pipeline.
- `.github/workflows/ci.yml` — execute the new post-build public variance validation.
- `packages/better-effect/README.md` — document Service token creation and exact Layer metadata.

## Chunk 1: Source Contracts

### Task 0: Capture the pre-change lint baseline

**Files:**
- Create ignored artifact: `.cache/public-type-variance-lint-baseline.json`

- [ ] **Step 1: Record normalized-comparable package diagnostics before editing source**

Run from the repository root:

```bash
mkdir -p .cache
cd packages/better-effect
set +e
bunx oxlint --type-aware --format json . > ../../.cache/public-type-variance-lint-baseline.json
baseline_status=$?
set -e
printf 'baseline oxlint exit: %s\n' "$baseline_status"
```

Expected: the ignored JSON file exists. A non-zero status is allowed only for the documented pre-existing anti-slop baseline. Do not modify source before capturing it; final verification compares diagnostic filename, rule code, and message while ignoring shifted source positions.

### Task 1: Make Service instance contracts invariant

**Files:**
- Create: `packages/better-effect/tests/types/service-variance.types.ts`
- Create: `packages/better-effect/src/internal/variance.ts`
- Modify: `packages/better-effect/src/service/types.ts`
- Modify: `packages/better-effect/src/service/service.ts`

- [ ] **Step 1: Add the failing Service assignability test**

Create `packages/better-effect/tests/types/service-variance.types.ts`:

```ts
import { Service, type ServiceClass, type ServiceToken } from '../../src/service'

class AnimalService extends Service<AnimalService>()('Animal') {
  readonly name: string = 'animal'
}

class DogService extends Service<DogService>()('Animal') {
  readonly name: string = 'dog'

  bark(): void {}
}

const dogClass: ServiceClass<'Animal', DogService> = DogService

// @ts-expect-error ServiceClass instance contracts are invariant
const widenedClass: ServiceClass<'Animal', AnimalService> = dogClass

const dogToken: ServiceToken<'Animal', DogService> = DogService

// @ts-expect-error ServiceToken instance contracts are invariant
const widenedToken: ServiceToken<'Animal', AnimalService> = dogToken

const widenedTag: ServiceClass<string, DogService> = dogClass

// @ts-expect-error a widened Service tag cannot be narrowed again
const narrowedTag: ServiceClass<'Animal', DogService> = widenedTag

class ManualService {
  static readonly serviceTag = 'Manual'

  static of(this: void, implementation: ManualService): ManualService {
    return implementation
  }

  run(): string {
    return 'manual'
  }
}

// @ts-expect-error Service tokens must originate from Service()
const manualToken: ServiceToken<'Manual', ManualService> = ManualService

// @ts-expect-error Service classes must originate from Service()
const manualClass: ServiceClass<'Manual', ManualService> = ManualService

class EquivalentLeft extends Service<EquivalentLeft>()('Equivalent') {
  execute(value: string): string {
    return value
  }
}

class EquivalentRight extends Service<EquivalentRight>()('Equivalent') {
  execute(value: string): string {
    return value
  }
}

const equivalentToken: ServiceToken<'Equivalent', EquivalentLeft> = EquivalentRight
const structural = DogService.of({
  name: 'structural dog',
  bark: () => {}
})

void widenedClass
void widenedToken
void widenedTag
void narrowedTag
void manualToken
void manualClass
void equivalentToken
void structural
```

The `void` lines intentionally keep declarations used without weakening the assignment checks.

- [ ] **Step 2: Run the current compiler and verify the test is red**

Run:

```bash
cd packages/better-effect
bunx tsc --noEmit --pretty false
```

Expected: non-zero exit with unused `@ts-expect-error` diagnostics for at least the widened `ServiceClass`, widened `ServiceToken`, and manually declared token/class assignments. The tag-narrowing error may already be correctly rejected before implementation; it protects the final covariant direction.

- [ ] **Step 3: Add the internal variance helpers**

Create `packages/better-effect/src/internal/variance.ts`:

```ts
/** Type-level marker for a value produced by `A`. */
export type Covariant<A> = () => A

/** Type-level marker that both consumes and produces `A`. */
export type Invariant<A> = (value: A) => A
```

Do not add an `index.ts`, root export, runtime constant, or unused contravariant helper.

- [ ] **Step 4: Replace the bivariant Service method contract and convert ServiceToken to an interface**

Update `packages/better-effect/src/service/types.ts` so its opening definitions and token declarations become:

```ts
import type { EffectRequirements } from '../effect/types'
import type { Covariant, Invariant } from '../internal/variance'

/** Internal type-only identity for Service token variance metadata. */
export declare const ServiceVarianceTypeId: unique symbol

/** Internal variance contract carried by every Service token. */
export interface ServiceVariance<out Tag extends string, in out Instance> {
  readonly _Tag: Covariant<Tag>
  readonly _Instance: Invariant<Instance>
}

export type ServiceStatics<out Tag extends string, in out Instance> = {
  readonly name: string
  readonly serviceTag: Tag
  readonly [ServiceVarianceTypeId]: ServiceVariance<Tag, Instance>

  /** Type-check a structural implementation and return it unchanged. */
  readonly of: (this: void, implementation: Instance) => Instance
}

type AbstractServiceConstructor<out Instance> = abstract new (
  ...args: any[]
) => Instance

/** A class constructor carrying a Service tag and its instance contract. */
export interface ServiceToken<
  out Tag extends string = string,
  in out Instance = any
> extends AbstractServiceConstructor<Instance>,
    ServiceStatics<Tag, Instance> {}
```

Remove the old `ServiceToken` intersection alias. Leave `AnyServiceToken`, `ServiceClass`, and the extraction helpers below it in place. `ServiceClass` remains a concrete-constructor intersection with `ServiceStatics`; do not add variance annotations directly to that intersection alias.

`ServiceStatics` is exported only from its source module so the factory signature can name it indirectly; do not re-export `ServiceStatics`, `ServiceVariance`, `ServiceVarianceTypeId`, or `AbstractServiceConstructor` from `src/service/index.ts` or the package root.

- [ ] **Step 5: Give `Service()` a TS4020-safe named factory signature**

Extend the type-only import in `packages/better-effect/src/service/service.ts`:

```ts
import type {
  AnyServiceToken,
  ServiceClass,
  ServiceInstance,
  ServiceRequirements,
  ServiceTag,
  ServiceToken,
  ServiceVariance,
  ServiceVarianceTypeId
} from './types'
```

Add this private interface after `ServiceTagLiteral`:

```ts
interface ServiceFactory<Self> {
  <const Tag extends string>(
    tag: ServiceTagLiteral<Tag>
  ): (abstract new () => object) &
    Pick<ServiceToken<Tag, Self>, keyof ServiceToken<any, any>> & {
      readonly [Symbol.asyncIterator]: (
        this: ServiceToken<Tag, Self>
      ) => AsyncGenerator<
        ServiceRequirement<ServiceToken<Tag, Self>>,
        Self,
        unknown
      >
    }
}
```

Annotate the public factory:

```ts
export function Service<Self>(): ServiceFactory<Self> {
```

Inside `BaseService`, immediately after `serviceTag`, add:

```ts
/** Type-only variance contract; this field is not emitted. */
static declare readonly [ServiceVarianceTypeId]: ServiceVariance<Tag, Self>
```

Keep the existing static `of` and async iterator implementations unchanged. The `Pick` exposes the existing public token's static keys without accumulating its recursive construct signature; `keyof ServiceToken<any, any>` avoids dangling `Tag`/`Self` identifiers in declarations emitted by TypeScript 5.2.

Do not introduce `Service.Heritage` or another public helper. The type-only symbol import and declared field must emit no JavaScript.

- [ ] **Step 6: Run the current compiler and verify the Service contract is green**

Run:

```bash
cd packages/better-effect
bunx tsc --noEmit --pretty false
```

Expected: zero exit. The new negative assignments consume their `@ts-expect-error` directives, and existing Service, Layer, Runtime, namespace, and example type contracts still compile.

- [ ] **Step 7: Format and lint the focused files**

Run:

```bash
cd packages/better-effect
bunx oxfmt --write \
  src/internal/variance.ts \
  src/service/types.ts \
  src/service/service.ts \
  tests/types/service-variance.types.ts
bunx oxlint --type-aware \
  src/internal/variance.ts \
  src/service/types.ts \
  src/service/service.ts \
  tests/types/service-variance.types.ts
bunx tsc --noEmit --pretty false
```

Expected: all commands exit zero. If Oxfmt changes files, retain its output rather than manually reformatting it.

- [ ] **Step 8: Commit the Service hardening**

```bash
git add \
  packages/better-effect/src/internal/variance.ts \
  packages/better-effect/src/service/types.ts \
  packages/better-effect/src/service/service.ts \
  packages/better-effect/tests/types/service-variance.types.ts
git commit -m "feat: make service instance contracts invariant"
```

### Task 2: Make Layer provider metadata exact

**Files:**
- Create: `packages/better-effect/tests/types/layer-variance.types.ts`
- Modify: `packages/better-effect/src/layer/layer.ts`
- Modify: `packages/better-effect/src/layer/inference.ts`
- Modify: `packages/better-effect/src/layer/types.ts`
- Modify: `packages/better-effect/src/effect/types.ts`
- Modify: `packages/better-effect/tests/types/public-type-namespaces.types.ts`
- Modify: `packages/better-effect/tests/package/public-type-namespaces/valid.ts`

- [ ] **Step 1: Add the failing Layer assignability and empty-Layer tests**

Create `packages/better-effect/tests/types/layer-variance.types.ts`:

```ts
import { expectTypeOf } from 'bun:test'

import type { EffectResult, ServiceRequirement } from '../../src/effect'
import {
  Layer,
  type LayerProvided,
  type LayerRawRequired,
  type LayerSpec
} from '../../src/layer'
import type { LayerCollisions } from '../../src/layer/inference'
import { Service, type ServiceToken } from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}

type DatabaseSpec = LayerSpec<typeof Database>
type LoggerSpec = LayerSpec<typeof Logger>

const DatabaseLive = Layer.make(Database)
declare const AppLive: Layer<DatabaseSpec | LoggerSpec>

const exact: Layer<DatabaseSpec> = DatabaseLive

// @ts-expect-error a Layer cannot invent a Logger provider
const invented: Layer<DatabaseSpec | LoggerSpec> = DatabaseLive

// @ts-expect-error a Layer cannot discard an exact provider specification
const narrowed: Layer<DatabaseSpec> = AppLive

// @ts-expect-error bare Layer is not an implicit metadata-erasure boundary
const bare: Layer = DatabaseLive

const erasedByAlias: Layer.Any = DatabaseLive
const erasedOrdinaryLayer: Layer<any, any> = DatabaseLive

const EmptyLive = Layer.merge()
const erasedEmptyLayer: Layer.Any = EmptyLive

// @ts-expect-error Layer<any, any> is not universal for never Specs
const incorrectlyErasedEmpty: Layer<any, any> = EmptyLive

expectTypeOf<LayerProvided<typeof EmptyLive>>().toEqualTypeOf<never>()
expectTypeOf<LayerRawRequired<typeof EmptyLive>>().toEqualTypeOf<never>()
expectTypeOf<LayerCollisions<typeof EmptyLive>>().toEqualTypeOf<never>()

type EmptyCollisionLayer = Layer<never, typeof Logger>

expectTypeOf<LayerProvided<EmptyCollisionLayer>>().toEqualTypeOf<never>()
expectTypeOf<LayerRawRequired<EmptyCollisionLayer>>().toEqualTypeOf<never>()
expectTypeOf<LayerCollisions<EmptyCollisionLayer>>().toEqualTypeOf<typeof Logger>()

declare const healthy: Layer<DatabaseSpec, never>
const conservativeCollision: Layer<DatabaseSpec, typeof Logger> = healthy

declare const collided: Layer<DatabaseSpec, typeof Logger>

// @ts-expect-error a known collision cannot be narrowed to never
const erasedCollision: Layer<DatabaseSpec, never> = collided

declare const specificSpec: LayerSpec<typeof Database, never>
const covariantSpec: LayerSpec<ServiceToken<string, Database>, typeof Logger> = specificSpec

declare const databaseRequirement: ServiceRequirement<typeof Database>
const covariantRequirement: ServiceRequirement<ServiceToken<string, Database>> =
  databaseRequirement

declare const databaseProgram: EffectResult<string, Error, typeof Database>
const conservativeProgram: EffectResult<
  string,
  Error,
  typeof Database | typeof Logger
> = databaseProgram

declare const fullProgram: EffectResult<string, Error, typeof Database | typeof Logger>

// @ts-expect-error Effect requirements cannot be narrowed
const incompleteProgram: EffectResult<string, Error, typeof Database> = fullProgram

void exact
void invented
void narrowed
void bare
void erasedByAlias
void erasedOrdinaryLayer
void erasedEmptyLayer
void incorrectlyErasedEmpty
void conservativeCollision
void erasedCollision
void covariantSpec
void covariantRequirement
void conservativeProgram
void incompleteProgram
```

- [ ] **Step 2: Run the current compiler and verify the Layer test is red**

Run:

```bash
cd packages/better-effect
bunx tsc --noEmit --pretty false
```

Expected: non-zero exit with unused `@ts-expect-error` diagnostics for `invented` and `bare`. Empty-Layer extraction may also expose incorrect inferred types. The already-unsafe reverse assignments remain rejected.

- [ ] **Step 3: Replace Layer's covariant phantom fields with one variance contract**

In `packages/better-effect/src/layer/layer.ts`, add:

```ts
import type { Covariant, Invariant } from '../internal/variance'
```

Replace the two existing Layer symbols with:

```ts
declare const LayerTypeId: unique symbol

interface LayerVariance<in out Specs, out Collisions> {
  readonly _Specs: Invariant<Specs>
  readonly _Collisions: Covariant<Collisions>
}
```

Change the class header and phantom declaration to:

```ts
export class Layer<
  in out Specs extends AnyLayerSpec = AnyLayerSpec,
  out Collisions extends AnyServiceToken = never
> {
  declare readonly [LayerTypeId]: LayerVariance<Specs, Collisions>
```

Remove `[LayerCollisionTypeId]`. Do not change provider storage or any runtime loop.

- [ ] **Step 4: Make `Layer.Any` universal and preserve `never` extraction**

Rewrite the opening extraction helpers in `packages/better-effect/src/layer/inference.ts` as:

```ts
/** Any Layer shape accepted by type-level inference helpers. */
export type AnyLayer = Layer<any, any> | Layer<never, any>

/** Extract the provider specification union from a Layer. */
export type LayerSpecs<L extends AnyLayer> = L extends Layer<never, any>
  ? never
  : L extends Layer<infer Specs, any>
    ? Specs
    : never

type LayerSpecProvided<Specs extends AnyLayerSpec> =
  Specs extends LayerSpec<infer Provided, any> ? Provided : never

type LayerSpecRequired<Specs extends AnyLayerSpec> =
  Specs extends LayerSpec<any, infer Required> ? Required : never

/** Extract the Service constructor union provided by a Layer. */
export type LayerProvided<L extends AnyLayer> = LayerSpecProvided<LayerSpecs<L>>

/** Extract all raw Service requirements declared by a Layer's providers. */
export type LayerRawRequired<L extends AnyLayer> = LayerSpecRequired<LayerSpecs<L>>
```

Remove the later duplicate `LayerSpecProvided` declaration. Replace `LayerCollisions` with:

```ts
/** Extract incompatible same-tag override contracts from a Layer. */
export type LayerCollisions<L extends AnyLayer> = L extends Layer<never, infer Collisions>
  ? Collisions
  : L extends Layer<any, infer Collisions>
    ? Collisions
    : never
```

These explicit branches prevent `never` Specs from inferring broad provider/requirement tokens or dropping collision metadata.

- [ ] **Step 5: Adjust only the Layer factory type boundaries affected by invariance**

Add `LayerCollisions` to the existing inference imports in `packages/better-effect/src/layer/layer.ts`.

Change `Layer.gen`'s return to the localized phantom-metadata cast:

```ts
// SAFETY: Layer.make tracks method requirements; the generator requirements
// below are additional type-only metadata inferred from the factory.
return Layer.make(service, () => runLayerGenerator(service, factory)) as Layer<
  LayerSpec<S, LayerGeneratorRequirements<S, Yield>>
>
```

Change `merge` to use distributive helpers:

```ts
static merge<const Layers extends readonly AnyLayer[]>(
  ...layers: Layers
): Layer<LayerSpecs<Layers[number]>, LayerCollisions<Layers[number]>> {
```

Change `override`'s header to:

```ts
static override<Base extends AnyLayer, const Overrides extends readonly AnyLayer[]>(
  base: Base,
  ...overrides: Overrides
): Layer<
  OverrideLayerSpecs<LayerSpecs<Base>, Overrides>,
  | LayerCollisions<Base>
  | LayerCollisions<Overrides[number]>
  | OverrideLayerCollisions<LayerSpecs<Base>, Overrides>
> {
```

Use the same helper-based arguments in its existing final cast:

```ts
return new Layer([...providers.values()]) as Layer<
  OverrideLayerSpecs<LayerSpecs<Base>, Overrides>,
  | LayerCollisions<Base>
  | LayerCollisions<Overrides[number]>
  | OverrideLayerCollisions<LayerSpecs<Base>, Overrides>
>
```

Keep all provider-map, duplicate, acquisition, release, and replacement code unchanged. No extra cast is needed in `make`, `succeed`, `scoped`, `scopedGen`, or `merge`.

- [ ] **Step 6: Declare covariance on immutable metadata descriptions**

Change `LayerSpec` in `packages/better-effect/src/layer/types.ts` to:

```ts
export type LayerSpec<
  out Provided extends AnyServiceToken,
  out Required extends AnyServiceToken = never
> = {
```

Change `ServiceRequirement` in `packages/better-effect/src/effect/types.ts` to:

```ts
export interface ServiceRequirement<out T extends AnyServiceToken> {
  readonly [ServiceRequirementTypeId]: T
}
```

Do not change `EffectResult`, its phantom property, requirement extraction, or runtime Effect code.

- [ ] **Step 7: Update the previously shipped `Layer.Any` namespace equality tests**

In `packages/better-effect/tests/types/public-type-namespaces.types.ts`, replace the `Layer.Any` assertion with:

```ts
expectTypeOf<Layer.Any>().toEqualTypeOf<Layer<any, any> | Layer<never, any>>()
```

In `packages/better-effect/tests/package/public-type-namespaces/valid.ts`, replace `LayerAnyAlias` with:

```ts
export type LayerAnyAlias = Expect<
  Equal<Layer.Any, Layer<any, any> | Layer<never, any>>
>
```

Do not alter any other namespace alias expectation.

- [ ] **Step 8: Run the current compiler and runtime tests**

Run:

```bash
cd packages/better-effect
bunx tsc --noEmit --pretty false
bun test
```

Expected: both commands exit zero. Exact Layer assignments, empty-Layer extraction, merge/override inference, existing namespace aliases, and all runtime behavior remain green.

- [ ] **Step 9: Format and lint the focused files**

Run:

```bash
cd packages/better-effect
bunx oxfmt --write \
  src/layer/layer.ts \
  src/layer/inference.ts \
  src/layer/types.ts \
  src/effect/types.ts \
  tests/types/layer-variance.types.ts \
  tests/types/public-type-namespaces.types.ts \
  tests/package/public-type-namespaces/valid.ts
bunx oxlint --type-aware \
  src/layer/layer.ts \
  src/layer/inference.ts \
  src/layer/types.ts \
  src/effect/types.ts \
  tests/types/layer-variance.types.ts \
  tests/types/public-type-namespaces.types.ts
bunx tsc --noEmit --pretty false
```

Expected: formatting and typecheck exit zero. The focused lint may retain the repository's documented pre-existing anti-slop diagnostics in `layer.ts`; record them and verify that no diagnostic points to a newly added or changed line. The built-package namespace fixture is omitted from this pre-build lint command because its package self-reference resolves through ignored `dist`; it is compiled and validated after build in Chunk 2.

- [ ] **Step 10: Commit the Layer and metadata hardening**

```bash
git add \
  packages/better-effect/src/layer/layer.ts \
  packages/better-effect/src/layer/inference.ts \
  packages/better-effect/src/layer/types.ts \
  packages/better-effect/src/effect/types.ts \
  packages/better-effect/tests/types/layer-variance.types.ts \
  packages/better-effect/tests/types/public-type-namespaces.types.ts \
  packages/better-effect/tests/package/public-type-namespaces/valid.ts
git commit -m "feat: preserve exact layer provider metadata"
```

## Chunk 2: Built-Package Contract

### Task 3: Validate assignability through generated declarations

**Files:**
- Create: `packages/better-effect/tests/package/public-type-variance/valid.ts`
- Create: `packages/better-effect/tests/package/public-type-variance/tsconfig.json`
- Modify: `packages/better-effect/package.json`

- [ ] **Step 1: Create the package-root consumer and declaration-emit fixture**

Create `packages/better-effect/tests/package/public-type-variance/valid.ts`:

```ts
import {
  Layer,
  Service,
  type EffectResult,
  type ServiceClass,
  type ServiceRequirement,
  type ServiceToken
} from 'better-effect'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

export class AnimalService extends Service<AnimalService>()('Animal') {
  readonly name: string = 'animal'
}

export class DogService extends Service<DogService>()('Animal') {
  readonly name: string = 'dog'

  bark(): void {}
}

const dogClass: ServiceClass<'Animal', DogService> = DogService

// @ts-expect-error built ServiceClass declarations preserve instance invariance
const widenedClass: ServiceClass<'Animal', AnimalService> = dogClass

const dogToken: ServiceToken<'Animal', DogService> = DogService

// @ts-expect-error built ServiceToken declarations preserve instance invariance
const widenedToken: ServiceToken<'Animal', AnimalService> = dogToken

const widenedTag: ServiceClass<string, DogService> = dogClass

// @ts-expect-error a widened built Service tag cannot be narrowed again
const narrowedTag: ServiceClass<'Animal', DogService> = widenedTag

class ManualService {
  static readonly serviceTag = 'Manual'

  static of(this: void, implementation: ManualService): ManualService {
    return implementation
  }

  run(): string {
    return 'manual'
  }
}

// @ts-expect-error built declarations preserve the hidden Service marker
const manualToken: ServiceToken<'Manual', ManualService> = ManualService

// @ts-expect-error built declarations preserve the hidden Service marker
const manualClass: ServiceClass<'Manual', ManualService> = ManualService

export class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

export class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}

type DatabaseSpec = {
  readonly provided: typeof Database
  readonly required: never
}

type LoggerSpec = {
  readonly provided: typeof Logger
  readonly required: never
}

const DatabaseLive = Layer.make(Database)
declare const AppLive: Layer<DatabaseSpec | LoggerSpec>

// @ts-expect-error built Layer declarations cannot invent providers
const invented: Layer<DatabaseSpec | LoggerSpec> = DatabaseLive

// @ts-expect-error built Layer declarations cannot discard providers
const narrowed: Layer<DatabaseSpec> = AppLive

// @ts-expect-error bare Layer is not an implicit erasure boundary
const bare: Layer = DatabaseLive

const erasedByAlias: Layer.Any = DatabaseLive
const erasedOrdinaryLayer: Layer<any, any> = DatabaseLive

const EmptyLive = Layer.merge()
const erasedEmptyLayer: Layer.Any = EmptyLive

// @ts-expect-error Layer<any, any> does not erase never Specs
const incorrectlyErasedEmpty: Layer<any, any> = EmptyLive

export type EmptyProvided = Expect<Equal<Layer.Provided<typeof EmptyLive>, never>>
export type EmptyRequired = Expect<Equal<Layer.Required<typeof EmptyLive>, never>>

declare const databaseRequirement: ServiceRequirement<typeof Database>
const covariantRequirement: ServiceRequirement<ServiceToken<string, Database>> =
  databaseRequirement

declare const databaseProgram: EffectResult<string, Error, typeof Database>
const conservativeProgram: EffectResult<
  string,
  Error,
  typeof Database | typeof Logger
> = databaseProgram

declare const fullProgram: EffectResult<string, Error, typeof Database | typeof Logger>

// @ts-expect-error built Effect requirements cannot be narrowed
const incompleteProgram: EffectResult<string, Error, typeof Database> = fullProgram

void widenedClass
void widenedToken
void widenedTag
void narrowedTag
void manualToken
void manualClass
void invented
void narrowed
void bare
void erasedByAlias
void erasedOrdinaryLayer
void erasedEmptyLayer
void incorrectlyErasedEmpty
void covariantRequirement
void conservativeProgram
void incompleteProgram
```

Do not import `LayerSpec`: it intentionally remains absent from the package root. Exported Service subclasses force both compilers to emit portable consumer declarations and expose TS4020/private-name regressions.

- [ ] **Step 2: Add the TypeScript 5.2-compatible declaration configuration**

Create `packages/better-effect/tests/package/public-type-variance/tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "ESNext.Disposable"],
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "rootDir": ".",
    "outDir": "out",
    "types": []
  },
  "files": ["valid.ts"]
}
```

The repository `.gitignore` already ignores directories named `out`.

- [ ] **Step 3: Add package scripts for both compilers**

In `packages/better-effect/package.json`, add:

```json
"test:package-variance": "rm -rf tests/package/public-type-variance/out && tsc --version && tsc -p tests/package/public-type-variance/tsconfig.json && rm -rf tests/package/public-type-variance/out",
"test:package-variance:minimum": "rm -rf tests/package/public-type-variance/out && bunx --bun --package typescript@5.2.2 tsc --version && bunx --bun --package typescript@5.2.2 tsc -p tests/package/public-type-variance/tsconfig.json && rm -rf tests/package/public-type-variance/out"
```

Do not add TypeScript as a new runtime dependency or change the peer range. The declaration-only emit is required; a `noEmit` fixture would not fully protect exported-subclass portability.

- [ ] **Step 4: Build the hardened declarations and run both compilers**

Run:

```bash
cd packages/better-effect
bun run build
bun run test:package-variance
bun run test:package-variance:minimum
```

Expected:

- build exits zero;
- current compiler reports its version, emits declarations for the exported subclasses, and exits zero;
- minimum compiler prints `Version 5.2.2`, emits the same portable declaration shape without TS4020, and exits zero;
- each successful script removes its temporary `out` directory.

The source-level tests in Chunk 1 provide the red/green cycle for the assignability behavior. This built-package task is the independent declaration-bundling and minimum-compiler verification and therefore does not depend on ignored or stale `dist` output for a second red phase.

If TypeScript 5.2 sees ambient Bun or Node declaration failures, confirm `types: []` is present and that the fixture imports only `better-effect`; do not weaken package types or raise the peer lower bound.

- [ ] **Step 5: Format, lint, and commit the built-package fixture**

Run:

```bash
cd packages/better-effect
bunx oxfmt --write \
  tests/package/public-type-variance/valid.ts \
  tests/package/public-type-variance/tsconfig.json \
  package.json
bunx oxlint --type-aware tests/package/public-type-variance/valid.ts
bun run test:package-variance
bun run test:package-variance:minimum
```

Expected: formatting, focused lint, and both compiler checks exit zero.

Commit:

```bash
git add \
  packages/better-effect/tests/package/public-type-variance/valid.ts \
  packages/better-effect/tests/package/public-type-variance/tsconfig.json \
  packages/better-effect/package.json
git commit -m "test: validate built type variance contracts"
```

### Task 4: Verify declaration shape and zero runtime emission

**Files:**
- Create: `packages/better-effect/tests/package/public-type-variance/check.ts`
- Modify: `packages/better-effect/package.json`

- [ ] **Step 1: Add the artifact checker**

Create `packages/better-effect/tests/package/public-type-variance/check.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const distRoot = join(packageRoot, 'dist')
const rootDeclaration = join(distRoot, 'index.d.mts')

const assertCondition = (condition: boolean, message: string): asserts condition => {
  if (!condition) {
    throw new Error(message)
  }
}

const collectFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)))
    } else {
      files.push(path)
    }
  }

  return files
}

const readDeclarationGraph = async (entry: string): Promise<string> => {
  const visited = new Set<string>()
  const sources: string[] = []

  const visit = async (path: string): Promise<void> => {
    if (visited.has(path)) {
      return
    }

    visited.add(path)

    const source = await readFile(path, 'utf8')
    sources.push(source)

    const localReferences = source.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*)["']((?:\.{1,2}\/)[^"']+\.mjs)["']/g
    )

    for (const match of localReferences) {
      const specifier = match[1]

      assertCondition(specifier !== undefined, `Invalid declaration import in ${path}`)

      await visit(resolve(dirname(path), specifier.replace(/\.mjs$/, '.d.mts')))
    }
  }

  await visit(entry)

  return sources.join('\n')
}

const declarations = await readDeclarationGraph(rootDeclaration)
const rootSource = await readFile(rootDeclaration, 'utf8')
const files = await collectFiles(distRoot)
const esmFiles = files.filter((path) => path.endsWith('.mjs'))
const esm = (await Promise.all(esmFiles.map((path) => readFile(path, 'utf8')))).join('\n')

const serviceStatics = declarations.match(
  /type ServiceStatics<out Tag extends string, in out Instance>\s*=\s*\{([\s\S]*?)\n?\};/
)

assertCondition(serviceStatics !== null, 'Generated declarations lost ServiceStatics variance')

const serviceStaticsBody = serviceStatics[1]

assertCondition(serviceStaticsBody !== undefined, 'Generated ServiceStatics has no body')
assertCondition(
  /readonly of: \(this: void, implementation: Instance\) => Instance;/.test(serviceStaticsBody),
  'Generated ServiceStatics lost its function-property contract'
)

const serviceMarker = serviceStaticsBody.match(
  /readonly \[([A-Za-z_$][\w$]*)\]: ([A-Za-z_$][\w$]*)<Tag, Instance>;/
)

assertCondition(serviceMarker !== null, 'Generated ServiceStatics lost its phantom marker')

const serviceMarkerName = serviceMarker[1]
const serviceVarianceName = serviceMarker[2]

assertCondition(serviceMarkerName !== undefined, 'Generated Service marker name is missing')
assertCondition(serviceVarianceName !== undefined, 'Generated Service variance name is missing')
assertCondition(
  new RegExp(`declare const ${serviceMarkerName}: unique symbol;`).test(declarations),
  'Generated Service phantom key is not a unique symbol'
)
assertCondition(
  new RegExp(
    `interface ${serviceVarianceName}<out Tag extends string, in out Instance>`
  ).test(declarations),
  'Generated Service marker lost its variance declaration'
)
assertCondition(
  /interface ServiceToken<out Tag extends string = string, in out Instance = any>\s+extends AbstractServiceConstructor<Instance>,\s*ServiceStatics<Tag, Instance>/.test(
    declarations
  ),
  'Generated ServiceToken lost its public variance contract'
)
assertCondition(
  /type [A-Za-z_$][\w$]*\s*=\s*Layer<any, any>\s*\|\s*Layer<never, any>/.test(
    declarations
  ),
  'Generated Layer.Any boundary lost its never-Specs branch'
)
assertCondition(
  /type LayerSpec<out Provided extends AnyServiceToken, out Required extends AnyServiceToken = never>/.test(
    declarations
  ),
  'Generated declarations lost LayerSpec covariance'
)
assertCondition(
  /interface ServiceRequirement<out T extends AnyServiceToken>/.test(declarations),
  'Generated declarations lost ServiceRequirement covariance'
)

const layerMarker = declarations.match(
  /declare class Layer<in out Specs extends AnyLayerSpec = AnyLayerSpec, out Collisions extends AnyServiceToken = never>\s*\{\s*readonly \[([A-Za-z_$][\w$]*)\]: ([A-Za-z_$][\w$]*)<Specs, Collisions>;/
)

assertCondition(layerMarker !== null, 'Generated Layer lost its variance marker')

const layerMarkerName = layerMarker[1]
const layerVarianceName = layerMarker[2]

assertCondition(layerMarkerName !== undefined, 'Generated Layer marker name is missing')
assertCondition(layerVarianceName !== undefined, 'Generated Layer variance name is missing')
assertCondition(
  new RegExp(`declare const ${layerMarkerName}: unique symbol;`).test(declarations),
  'Generated Layer phantom key is not a unique symbol'
)
assertCondition(
  new RegExp(`interface ${layerVarianceName}<in out Specs, out Collisions>`).test(
    declarations
  ),
  'Generated Layer marker lost its variance declaration'
)

const rootExportsLayerSpec =
  /\bexport\s+(?:declare\s+)?(?:type|interface|class)\s+LayerSpec\b/.test(rootSource) ||
  /\bexport\s+(?:type\s+)?\{[^}]*\bLayerSpec\b[^}]*\}/s.test(rootSource)

assertCondition(!rootExportsLayerSpec, 'LayerSpec was unexpectedly promoted to a package-root export')

for (const typeOnlyName of [
  serviceMarkerName,
  serviceVarianceName,
  layerMarkerName,
  layerVarianceName
]) {
  assertCondition(
    !esm.includes(typeOnlyName),
    `Type-only variance metadata leaked into generated ESM as ${typeOnlyName}`
  )
}

const built = await import(pathToFileURL(join(distRoot, 'index.mjs')).href)
const service = built.Service()('VarianceArtifactService')
const layer = built.Layer.make(service)
const serviceSymbols = Object.getOwnPropertySymbols(service)
const layerSymbols = Object.getOwnPropertySymbols(layer)

assertCondition(
  serviceSymbols.length === 1 && serviceSymbols[0] === Symbol.asyncIterator,
  'Service variance metadata created an unexpected runtime symbol property'
)
assertCondition(layerSymbols.length === 0, 'Layer variance metadata created a runtime symbol property')

console.log('Public type variance package checks passed')
```

The compiler fixture is the authoritative semantic check, including exported-subclass declaration emit. The traversal follows `./`, `../`, static, and dynamic local declaration references. Shape checks capture private marker names from their declarations instead of assuming bundler chunk names, then correlate each marker key with a `unique symbol`. Runtime reflection catches accidental emitted fields even if internal identifiers are renamed.

- [ ] **Step 2: Add the complete focused package script**

Add to `packages/better-effect/package.json` now that `check.ts` exists:

```json
"check:public-type-variance": "bun run test:package-variance && bun run test:package-variance:minimum && bun tests/package/public-type-variance/check.ts"
```

- [ ] **Step 3: Run the artifact checker after build**

Run:

```bash
cd packages/better-effect
bun run build
bun tests/package/public-type-variance/check.ts
```

Expected: `Public type variance package checks passed` and zero exit.

- [ ] **Step 4: Run the complete focused package check**

Run:

```bash
cd packages/better-effect
bun run check:public-type-variance
```

Expected: current compiler and TypeScript 5.2.2 both emit portable fixture declarations and succeed, their temporary output is removed, and the artifact checker prints its success message.

- [ ] **Step 5: Format, lint, and commit the checker**

Run:

```bash
cd packages/better-effect
bunx oxfmt --write \
  tests/package/public-type-variance/check.ts \
  package.json
bunx oxlint --type-aware tests/package/public-type-variance/check.ts
bun run check:public-type-variance
```

Expected: all commands exit zero.

Commit:

```bash
git add \
  packages/better-effect/tests/package/public-type-variance/check.ts \
  packages/better-effect/package.json
git commit -m "test: verify variance metadata is type only"
```

## Chunk 3: Integration and Documentation

### Task 5: Integrate CI and document the hardened contracts

**Files:**
- Modify: `packages/better-effect/package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `packages/better-effect/README.md`

- [ ] **Step 1: Add the variance check to the package-wide check script**

Update `packages/better-effect/package.json` so `check` runs the new command immediately after the existing namespace check:

```json
"check": "bun run typecheck && bun test && bun run format && bun run build && bun run check:public-type-namespaces && bun run check:public-type-variance && bun run publint && bun run lint"
```

Keep the existing namespace validation and command ordering otherwise unchanged.

- [ ] **Step 2: Add the post-build CI boundary**

In `.github/workflows/ci.yml`, add immediately after `Validate public type namespaces`:

```yaml
      - name: Validate public type variance
        working-directory: packages/better-effect
        run: bun run check:public-type-variance
```

Do not remove or suppress typecheck, tests, build, package validation, package inspection, or lint.

- [ ] **Step 3: Clarify the Service token contract in the README**

After the paragraph explaining that `Authorization.of(...)` does not construct an instance, add to `packages/better-effect/README.md`:

```md
Service tokens themselves are always declared through `Service<Self>()(tag)`.
`Service.of(...)` creates a type-checked structural implementation for an
existing token; it does not create an alternate token. This keeps the token's
instance contract tied to the class used by Layers and resolver backends.
```

- [ ] **Step 4: Clarify exact Layer metadata and intentional erasure**

After the paragraph beginning “The Services your code uses” and before “Discover type helpers”, add:

```md
A Layer's type describes its exact provider composition. Preserve the inferred
Layer type at application boundaries so TypeScript cannot claim providers that
are absent at runtime. Generic infrastructure that intentionally erases this
metadata can use `Layer.Any`, including for an empty Layer. `Layer<any, any>`
does not cover the `never` Specs of an empty Layer, and a bare `Layer` is not an
implicit erasure boundary.
```

Do not document `LayerSpec` as a package-root export and do not introduce runtime TypeId or guard documentation.

- [ ] **Step 5: Format and run focused integration checks**

Run:

```bash
bunx oxfmt --write \
  packages/better-effect/package.json \
  packages/better-effect/README.md \
  .github/workflows/ci.yml
cd packages/better-effect
bun run typecheck
bun run build
bun run check:public-type-namespaces
bun run check:public-type-variance
bun run publint
```

Expected: every command exits zero. The existing namespace checker must continue to pass after declaration-shape changes.

- [ ] **Step 6: Commit integration and documentation**

```bash
git add \
  packages/better-effect/package.json \
  packages/better-effect/README.md \
  .github/workflows/ci.yml
git commit -m "docs: explain exact service and layer contracts"
```

### Task 6: Run final verification

**Files:**
- Verify all changed files; modify only if a command exposes a feature-related issue.

- [ ] **Step 1: Identify the implementation range and inspect the working tree**

Run:

```bash
BASE_SHA=$(git rev-list -1 --grep='^docs: plan public type variance hardening$' HEAD)
test -n "$BASE_SHA"
git status --short
git diff --name-status "$BASE_SHA"..HEAD
git log "$BASE_SHA"..HEAD --oneline
```

Expected: no unexpected files. The implementation range contains only the focused Service, Layer, package-fixture, artifact, CI, and documentation changes; it does not depend on a fixed commit count.

- [ ] **Step 2: Run Oxfmt's check mode on every changed file**

Run from the repository root:

```bash
bunx oxfmt --check \
  packages/better-effect/src/internal/variance.ts \
  packages/better-effect/src/service/types.ts \
  packages/better-effect/src/service/service.ts \
  packages/better-effect/src/layer/layer.ts \
  packages/better-effect/src/layer/inference.ts \
  packages/better-effect/src/layer/types.ts \
  packages/better-effect/src/effect/types.ts \
  packages/better-effect/tests/types/service-variance.types.ts \
  packages/better-effect/tests/types/layer-variance.types.ts \
  packages/better-effect/tests/types/public-type-namespaces.types.ts \
  packages/better-effect/tests/package/public-type-namespaces/valid.ts \
  packages/better-effect/tests/package/public-type-variance/valid.ts \
  packages/better-effect/tests/package/public-type-variance/tsconfig.json \
  packages/better-effect/tests/package/public-type-variance/check.ts \
  packages/better-effect/package.json \
  packages/better-effect/README.md \
  .github/workflows/ci.yml
```

Expected: zero exit. Do not rely on the workspace `format:check` aggregation, which may skip packages without a wired script.

- [ ] **Step 3: Run the required repository check and compare lint diagnostics semantically**

Run from the repository root:

```bash
set -e
bun run typecheck
bun test
bun run build
bun run publint
cd packages/better-effect
bun run check:public-type-namespaces
bun run check:public-type-variance
cd ../..

set +e
bun run check
check_status=$?
cd packages/better-effect
bunx oxlint --type-aware --format json . > ../../.cache/public-type-variance-lint-current.json
lint_status=$?
cd ../..
set -e
printf 'repository check exit: %s\ncurrent oxlint exit: %s\n' "$check_status" "$lint_status"

if [ "$check_status" -ne 0 ] && [ "$lint_status" -eq 0 ]; then
  echo 'Repository check failed even though package lint passed' >&2
  exit 1
fi

bun - <<'EOF'
const baseline = await Bun.file('.cache/public-type-variance-lint-baseline.json').json()
const current = await Bun.file('.cache/public-type-variance-lint-current.json').json()

const key = (diagnostic) =>
  JSON.stringify([diagnostic.filename, diagnostic.code, diagnostic.message])

const remaining = new Map()

for (const diagnostic of baseline.diagnostics) {
  const diagnosticKey = key(diagnostic)
  remaining.set(diagnosticKey, (remaining.get(diagnosticKey) ?? 0) + 1)
}

const additions = []

for (const diagnostic of current.diagnostics) {
  const diagnosticKey = key(diagnostic)
  const count = remaining.get(diagnosticKey) ?? 0

  if (count === 0) {
    additions.push(diagnostic)
  } else {
    remaining.set(diagnosticKey, count - 1)
  }
}

if (additions.length > 0) {
  console.error(JSON.stringify(additions, null, 2))
  throw new Error('Variance hardening introduced new lint diagnostics')
}
EOF
```

Expected: the explicit typecheck, test, build, publint, public namespace, and public variance boundaries exit zero before the potentially baseline-failing aggregate check. Both TypeScript 5.2/current declaration fixtures and artifact checks therefore cannot be hidden by the later lint baseline. The aggregate command may retain the pre-change lint exit; the normalized comparison must report no added filename/code/message tuple, even when edits shift existing diagnostic positions. Report an unchanged baseline separately rather than claiming a clean full check.

- [ ] **Step 4: Inspect the package contents**

Run:

```bash
cd packages/better-effect
bun pm pack --dry-run
```

Expected: zero exit; `dist/index.mjs`, declaration files, and supported subpaths are included, while source tests and internal variance sources are not published independently.

- [ ] **Step 5: Review the final diff and generated behavior**

Run:

```bash
BASE_SHA=$(git rev-list -1 --grep='^docs: plan public type variance hardening$' HEAD)
test -n "$BASE_SHA"
git status --short
git diff "$BASE_SHA"..HEAD --check
git diff "$BASE_SHA"..HEAD --stat
```

Expected: no whitespace errors, no uncommitted implementation changes, and no files outside the approved source, test, CI, package-script, and README scope.

- [ ] **Step 6: Record any verification-only fix**

If final verification required a source-controlled correction, commit only that correction:

```bash
git add <corrected-files>
git commit -m "fix: address variance verification issue"
```

Then repeat Tasks 6 Steps 2–5 in full: Oxfmt check, repository check plus normalized lint comparison, package dry-run inspection, and final diff/status review. A fix validated only by the originally failing command is not complete. If no correction was needed, do not create an empty commit.

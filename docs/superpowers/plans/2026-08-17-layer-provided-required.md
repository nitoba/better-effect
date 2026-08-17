# Layer Provided and Required Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace public `Layer<LayerSpec<...>, Collisions>` types with `Layer<Provided, Required>`, where both channels are Service instances and `Required` contains only dependencies external to the composed Layer.

**Architecture:** Keep the public Layer class at two generic parameters and carry exact per-provider requirement provenance in a package-private, declaration-only intersection keyed by a `unique symbol`. Split precise provider entries from sticky erased provenance, reject concrete Layer unions and partial-`any` shapes before generic widening, reject incompatible overrides at `Layer.override`, and leave runtime provider storage and lifecycle behavior unchanged.

**Tech Stack:** TypeScript 5.7+, Bun, `bun:test`, `better-result`, tsdown, Oxfmt, Oxlint, publint.

**Design spec:** `docs/superpowers/specs/2026-08-17-layer-provided-required-design.md`

**Execution constraints:** Work on the current `feat/add-namespaces` branch; do not create a worktree. Use TDD. Do not run OpenSpec CLI workflows; update current main specs directly and leave archived changes untouched.

---

## File Structure

### New focused files

- `packages/better-effect/src/layer/metadata.ts` — package-private provider entries, erased provenance, declaration-only carrier, and extraction helpers. It must not be exported from a public barrel.
- `packages/better-effect/tests/types/layer-environments.types.ts` — primary source-level contract for public `Provided`/external `Required`, precise composition, erased provenance, sentinels, unions, and call-site override diagnostics.
- `packages/better-effect/tests/package/public-type-namespaces/invalid-layer-exports.ts` — built-package fixture proving removed Layer metadata names are no longer importable.
- `packages/better-effect/tests/package/public-type-namespaces/tsconfig.invalid-layer-exports.json` — isolated negative fixture config.

### Existing responsibilities retained

- `packages/better-effect/src/layer/types.ts` — runtime registration and generator callback contracts only; remove public provider-spec types.
- `packages/better-effect/src/layer/inference.ts` — Service matching, Layer input classification, public channel projections, merge/override type transforms, completeness diagnostics, and execution matching.
- `packages/better-effect/src/layer/layer.ts` — runtime Layer value plus public constructors/combinators.
- `packages/better-effect/src/layer/runtime.ts` — RuntimeHandle construction from namespace/internal Layer helpers.
- `packages/better-effect/src/runtime/runtime.ts` and `packages/better-effect/src/runtime/types.ts` — complete-Layer boundaries and `Runtime.For` using `Layer.Provided`.
- `packages/better-effect/src/layer/index.ts` and `packages/better-effect/src/index.ts` — reduced public exports.
- Existing source and package type tests — migrate from raw specs/missing aliases to the two public channels.

---

## Chunk 1: Core Layer Type Model

### Task 1: Establish the two-channel Layer contract in RED tests

**Files:**

- Create: `packages/better-effect/tests/types/layer-environments.types.ts`
- Create: `packages/better-effect/tests/types/tsconfig.layer-environments.json`
- Reference: `docs/superpowers/specs/2026-08-17-layer-provided-required-design.md`

- [ ] **Step 0: Record the implementation and lint baselines**

Run before changing source or tests:

```bash
git rev-parse HEAD > /tmp/better-effect-layer-implementation-base
cd packages/better-effect
bun run lint > /tmp/better-effect-layer-lint-baseline.log 2>&1 || true
cd ../..
```

Expected: the SHA is the committed plan/design tip. The lint command may exit nonzero because of known anti-slop debt; retain the complete log for the final multiset comparison.

- [ ] **Step 1: Add minimal Services and constructor inference assertions**

Create the test with `bun:test`'s `expectTypeOf` and these representative declarations:

```ts
import { expectTypeOf } from 'bun:test'

import { Layer } from '../../src/layer'
import { Service } from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class Config extends Service<Config>()('Config') {
  value(): string {
    return 'config'
  }
}

class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  find(): string {
    return 'user'
  }
}

const DatabaseLive = Layer.make(Database)
const RepositoryLive = Layer.gen(UserRepository, async function* () {
  const database = yield* Database
  const config = yield* Config
  const logger = yield* Logger

  void database
  void config
  void logger

  return new UserRepository()
})

expectTypeOf<Layer.Provided<typeof DatabaseLive>>().toEqualTypeOf<Database>()
expectTypeOf<Layer.Required<typeof DatabaseLive>>().toBeNever()
expectTypeOf<Layer.Provided<typeof RepositoryLive>>().toEqualTypeOf<UserRepository>()
expectTypeOf<Layer.Required<typeof RepositoryLive>>().toEqualTypeOf<Database | Config | Logger>()
```

- [ ] **Step 2: Add merge assertions for external requirements**

Append:

```ts
const AppLive = Layer.merge(DatabaseLive, RepositoryLive)

expectTypeOf<Layer.Provided<typeof AppLive>>().toEqualTypeOf<Database | UserRepository>()
expectTypeOf<Layer.Required<typeof AppLive>>().toEqualTypeOf<Config | Logger>()

const EmptyLive = Layer.merge()
expectTypeOf<Layer.Provided<typeof EmptyLive>>().toBeNever()
expectTypeOf<Layer.Required<typeof EmptyLive>>().toBeNever()
```

- [ ] **Step 3: Add all constructor, self-requirement, and basic override assertions before implementation**

Add `succeed`, `scoped`, `gen`, and `scopedGen` assertions proving each provides the requested instance and tracks method plus yielded requirements. Add a Service whose method requires itself and prove the self requirement is removed from the public external channel. Add a basic compatible override whose replacement no longer has an acquisition requirement and assert that `Layer.Required` becomes `never`. Add two same-tag classes with incompatible Rich/Lean contracts and a `@ts-expect-error` on `Layer.override` so call-site rejection is RED before implementation.

For scoped callbacks, preserve exact callback types:

```ts
const ScopedRepository = Layer.scoped(
  UserRepository,
  () => new UserRepository(),
  (repository) => {
    expectTypeOf(repository).toEqualTypeOf<UserRepository>()
  }
)

const ScopedGeneratedRepository = Layer.scopedGen(
  UserRepository,
  async function* () {
    const database = yield* Database
    return new UserRepository()
  },
  (repository, outcome) => {
    expectTypeOf(repository).toEqualTypeOf<UserRepository>()
    expectTypeOf(outcome.status).toEqualTypeOf<'success' | 'failure'>()
  }
)

expectTypeOf<Layer.Required<typeof ScopedGeneratedRepository>>().toEqualTypeOf<Database>()
```

- [ ] **Step 4: Add authored two-parameter boundary assertions**

Append:

```ts
const checked = RepositoryLive satisfies Layer<UserRepository, Database | Config | Logger>

// @ts-expect-error a Layer cannot invent Database as a provided Service
const invented: Layer<UserRepository | Database, Database | Config | Logger> = RepositoryLive

// @ts-expect-error required Services cannot be narrowed
const narrowedRequirement: Layer<UserRepository, Database> = RepositoryLive

void checked
void invented
void narrowedRequirement
```

- [ ] **Step 5: Add a focused TypeScript project**

Create `tests/types/tsconfig.layer-environments.json`:

```json
{
  "extends": "../../tsconfig.json",
  "files": ["layer-environments.types.ts"],
  "include": []
}
```

This compiles imported source transitively without executing declaration-only test values.

- [ ] **Step 6: Run the focused project and verify RED under both compilers**

Run:

```bash
cd packages/better-effect
bun run --silent tsc -- -p tests/types/tsconfig.layer-environments.json
bunx --bun --package typescript@5.7.2 tsc -p tests/types/tsconfig.layer-environments.json
```

Expected: both FAIL on the new two-channel assertions because the current class expects `LayerSpec` metadata, `Layer.Required` is raw rather than external, and merged requirements are not projected through the new channels.

### Task 2: Introduce package-private provenance and the public two-parameter Layer

**Files:**

- Create: `packages/better-effect/src/layer/metadata.ts`
- Modify: `packages/better-effect/src/layer/types.ts`
- Modify: `packages/better-effect/src/layer/index.ts`
- Modify: `packages/better-effect/src/layer/inference.ts`
- Modify: `packages/better-effect/src/layer/layer.ts`
- Modify: `packages/better-effect/src/layer/runtime.ts`
- Modify: `packages/better-effect/src/runtime/runtime.ts`
- Modify: `packages/better-effect/src/runtime/types.ts`
- Test: `packages/better-effect/tests/types/layer-environments.types.ts`
- Test: `packages/better-effect/tests/types/layer.types.ts`
- Test: `packages/better-effect/tests/types/layer-scoped-gen.types.ts`
- Test: `packages/better-effect/tests/types/layer-variance.types.ts`
- Test: `packages/better-effect/tests/types/service-identity.types.ts`
- Test: `packages/better-effect/tests/types/public-type-namespaces.types.ts`
- Test: `packages/better-effect/tests/types/instance-requirements.types.ts`

- [ ] **Step 1: Add declaration-only metadata primitives**

Create `src/layer/metadata.ts` with no runtime values:

```ts
import type { AnyService } from '../service'

import type { Layer } from './layer'

export declare const LayerProvenanceTypeId: unique symbol

export interface ProviderEntry<
  out Provided extends AnyService,
  out RawRequired extends AnyService = never
> {
  readonly provided: Provided
  readonly required: RawRequired
}

export interface ErasedProvenance<
  out Provided extends AnyService,
  out StickyRequired extends AnyService
> {
  readonly provided: Provided
  readonly stickyRequired: StickyRequired
}

export interface LayerProvenance<
  out Entries extends ProviderEntry<AnyService, AnyService> = never,
  out Erased extends ErasedProvenance<AnyService, AnyService> = never
> {
  readonly [LayerProvenanceTypeId]: {
    readonly entries: Entries
    readonly erased: Erased
  }
}

export type InternalLayer = Layer<any, any> | Layer<never, any>
```

If TS 5.7 needs variance adjustments, preserve the behavior rather than the exact syntax: precise entries and erased provenance must remain separately inferable and the declaration symbol must emit no JavaScript.

- [ ] **Step 2: Stop using provider specs without removing package exports yet**

Keep temporary compatibility declarations for `LayerSpec` and `AnyLayerSpec` until Chunk 2's package-surface RED fixture is in place, but remove every production dependency on them. Keep `LayerRegistration`, `LayerGenerator`, and `LayerGeneratorRequirements` as the real contracts. Mark temporary aliases for deletion in Task 5; do not document or extend them.

- [ ] **Step 3: Replace Layer's generic parameters and variance**

Change the class skeleton in `layer/layer.ts` to:

```ts
interface LayerVariance<in out Provided, out Required> {
  readonly _Provided: Invariant<Provided>
  readonly _Required: Covariant<Required>
}

export class Layer<
  in out Provided extends AnyService = AnyService,
  out Required extends AnyService = AnyService
> {
  declare readonly [LayerTypeId]: LayerVariance<Provided, Required>
  readonly providers: readonly LayerProvider[]
  // existing runtime constructor and behavior remain unchanged
}
```

Do not add a runtime provenance property.

- [ ] **Step 4: Implement metadata projections and Layer-specific requirement calculation**

In `layer/inference.ts`, retain concrete Service matching (`SameService`, `MissingServices`) for Runtime execution. Add internal helpers equivalent to:

```ts
type PublicProvided<L extends InternalLayer> =
  L extends Layer<infer Provided, any> ? Provided : never

type PublicRequired<L extends InternalLayer> =
  L extends Layer<any, infer Required> ? Required : never

type PreciseEntries<L extends InternalLayer> =
  L extends LayerProvenance<infer Entries, any> ? Entries : never

type ErasedEntries<L extends InternalLayer> =
  L extends LayerProvenance<any, infer Erased>
    ? Erased
    : ErasedProvenance<PublicProvided<L>, PublicRequired<L>>
```

Add a Layer-only external requirement helper that preserves widened `Service.Any` instead of applying Runtime's unchecked widened-tag rule:

```ts
type LayerExternalRequirements<RawRequired, Provided> =
  true extends HasWidenedTag<Extract<RawRequired | Provided, AnyService>>
    ? Extract<RawRequired, AnyService>
    : MissingServices<Extract<RawRequired, AnyService>, Extract<Provided, AnyService>>
```

The existential `true extends ...` check is required because widened and concrete Services can form a distributive `true | false` result. `any` sentinel classification is added in Task 4; do not let this helper silently turn a bare `Layer` complete.

- [ ] **Step 5: Add the opaque result constructor**

Define every referenced extractor before the result alias:

```ts
type AnyProviderEntry = ProviderEntry<AnyService, AnyService>
type AnyErasedProvenance = ErasedProvenance<AnyService, AnyService>

type EntryProvided<Entries> = Entries extends ProviderEntry<infer Provided, any> ? Provided : never

type EntryRequired<Entries> = Entries extends ProviderEntry<any, infer Required> ? Required : never

type ErasedProvided<Erased> =
  Erased extends ErasedProvenance<infer Provided, any> ? Provided : never

type ErasedRequired<Erased> =
  Erased extends ErasedProvenance<any, infer Required> ? Required : never
```

Then implement:

```ts
export type LayerResult<
  Entries extends AnyProviderEntry,
  Erased extends AnyErasedProvenance = never
> = Layer<
  EntryProvided<Entries> | ErasedProvided<Erased>,
  LayerExternalRequirements<
    EntryRequired<Entries> | ErasedRequired<Erased>,
    EntryProvided<Entries> | ErasedProvided<Erased>
  >
> &
  LayerProvenance<Entries, Erased>
```

Keep all entry/provenance helpers package-private: they may be exported between source modules but never from `src/layer/index.ts` or `src/index.ts`.

- [ ] **Step 6: Migrate provider constructor return types**

Use `ProviderEntry<InstanceType<S>, RawRequired>` for every constructor:

```ts
static make<S extends DefaultConstructibleServiceClass<any, any>>(
  service: S
): LayerResult<ProviderEntry<InstanceType<S>, ServiceRequirements<InstanceType<S>>>>

static gen<S extends ServiceClass<any, any>, Yield extends ServiceRequirement<unknown>>(
  service: S,
  factory: LayerGenerator<S, Yield>
): LayerResult<ProviderEntry<InstanceType<S>, LayerGeneratorRequirements<S, Yield>>>
```

Apply the same model to `make` with acquisition, `succeed`, `scoped`, and `scopedGen`. Keep constructor tokens only in each runtime `LayerProvider.service` value. Localize casts at the existing type-erasure boundary.

- [ ] **Step 7: Implement merge over precise and erased channels**

For each original tuple element, extract precise entries and erased provenance separately. Return a `LayerResult` carrying both unions. The public `Required` must be recomputed after all provided Services are known.

Keep runtime duplicate-tag handling exactly as it is. Do not use `Layers[number]` as evidence that an individual argument is a union; Task 4 adds per-element validation.

- [ ] **Step 8: Migrate internal Runtime signatures to internal/namespace helpers**

Replace source imports of removed public aliases with package-private helpers or namespace aliases. The resulting public signatures should be equivalent to:

```ts
createRuntimeHandle<L extends Layer.Any>(
  layer: Layer.Complete<L>,
  backend: LayerBackend,
  options?: RuntimeOptions
): Promise<RuntimeHandle<Layer.Provided<L>>>

Runtime.make<L extends Layer.Any>(
  layer: Layer.Complete<L>,
  backend: LayerBackend,
  options?: RuntimeOptions
): Promise<Runtime<Layer.Provided<L>>>
```

Retain `CompleteExecution` internally for Effect execution checks.

- [ ] **Step 9: Implement the basic compatible/incompatible override contract already covered by RED tests**

Use precise provider entries for a basic compatible replacement and reject a basic same-tag incompatible replacement at `Layer.override`. Remove the old production collision generic and late collision branch now; Task 3 extends the algorithm to mixed erased provenance and adversarial unions.

- [ ] **Step 10: Migrate every baseline source type consumer to namespace channels**

In `layer.types.ts`, `layer-scoped-gen.types.ts`, `instance-requirements.types.ts`, and `public-type-namespaces.types.ts`:

- replace `LayerMissing<L>` with `Layer.Required<L>`;
- replace `CompleteLayer<L>` with `Layer.Complete<L>`;
- replace `LayerRawRequired<L>` with the new external `Layer.Required<L>` expectations;
- update complete merges to expect `never` after provided Services are subtracted.

In `layer-variance.types.ts`, replace spec-based annotations with `Layer<Provided, Required>`, remove collision-generic assertions, and retain invariance/covariance tests:

```ts
const exact: Layer<Database, never> = DatabaseLive
// @ts-expect-error cannot invent Logger
const invented: Layer<Database | Logger, never> = DatabaseLive

declare const needsDatabaseAndLogger: Layer<Database, Database | Logger>
// @ts-expect-error Required cannot be narrowed
const needsOnlyDatabase: Layer<Database, Database> = needsDatabaseAndLogger
```

In `service-identity.types.ts`, declare the actual base value before the negative assertion:

```ts
const IncompatibleDatabaseALive = Layer.make(
  IncompatibleDatabaseA,
  () => new IncompatibleDatabaseA()
)

// @ts-expect-error same-tag contracts are incompatible at Layer.override
Layer.override(IncompatibleDatabaseALive, IncompatibleDatabaseBLive)
```

Remove the old late `CompleteLayer` collision assertion so full typecheck does not depend on deleted collision state.

- [ ] **Step 11: Run focused and full source type checks under both compilers**

Run:

```bash
cd packages/better-effect
bun run --silent tsc -- -p tests/types/tsconfig.layer-environments.json
bunx --bun --package typescript@5.7.2 tsc -p tests/types/tsconfig.layer-environments.json
bun run typecheck
bunx --bun --package typescript@5.7.2 tsc --noEmit -p tsconfig.json
```

Expected: all PASS. Runtime tests are not expected to change behavior.

- [ ] **Step 12: Commit the two-channel core**

```bash
git add \
  packages/better-effect/src/layer/metadata.ts \
  packages/better-effect/src/layer/types.ts \
  packages/better-effect/src/layer/index.ts \
  packages/better-effect/src/layer/inference.ts \
  packages/better-effect/src/layer/layer.ts \
  packages/better-effect/src/layer/runtime.ts \
  packages/better-effect/src/runtime/runtime.ts \
  packages/better-effect/src/runtime/types.ts \
  packages/better-effect/tests/types/layer-environments.types.ts \
  packages/better-effect/tests/types/tsconfig.layer-environments.json \
  packages/better-effect/tests/types/layer.types.ts \
  packages/better-effect/tests/types/layer-scoped-gen.types.ts \
  packages/better-effect/tests/types/layer-variance.types.ts \
  packages/better-effect/tests/types/service-identity.types.ts \
  packages/better-effect/tests/types/public-type-namespaces.types.ts \
  packages/better-effect/tests/types/instance-requirements.types.ts
git commit -m "feat: expose Layer provided and required environments"
```

### Task 3: Preserve precise overrides and sticky erased requirements

**Files:**

- Modify: `packages/better-effect/tests/types/layer-environments.types.ts`
- Modify: `packages/better-effect/tests/types/service-identity.types.ts`
- Modify: `packages/better-effect/src/layer/inference.ts`
- Modify: `packages/better-effect/src/layer/layer.ts`

- [ ] **Step 1: Add RED tests for precise and mixed provenance**

Add Services `Mailer`, `FactoryDependency`, and replacement factories to `layer-environments.types.ts`. Cover:

```ts
const RepositoryFromDatabase = Layer.gen(UserRepository, async function* () {
  const database = yield* Database
  void database
  return new UserRepository()
})

const MailerFromConfig = Layer.gen(Mailer, async function* () {
  const config = yield* Config
  void config
  return new Mailer()
})

const Base = Layer.merge(RepositoryFromDatabase, MailerFromConfig)
const RepositoryFake = Layer.succeed(UserRepository, new UserRepository())
const PreciseOverride = Layer.override(Base, RepositoryFake)

expectTypeOf<Layer.Required<typeof PreciseOverride>>().toEqualTypeOf<Config>()

const ErasedMailer: Layer<Mailer, Config> = MailerFromConfig
const Mixed = Layer.merge(RepositoryFromDatabase, ErasedMailer)
const MixedRepositoryOverride = Layer.override(Mixed, RepositoryFake)
const MixedMailerOverride = Layer.override(Mixed, Layer.succeed(Mailer, new Mailer()))

expectTypeOf<Layer.Required<typeof MixedRepositoryOverride>>().toEqualTypeOf<Config>()
expectTypeOf<Layer.Required<typeof MixedMailerOverride>>().toEqualTypeOf<Database | Config>()
```

Also cover an erased `Layer<never, Config>` whose sticky Config disappears only after merging a concrete Config provider.

- [ ] **Step 2: Add adversarial call-site and erased-provided tests**

Add a same-tag compatible replacement class with different constructor parameters/statics. Override an explicitly erased `Layer<Original | Unrelated, R>` and assert `Layer.Provided` removes only the compatible original member, retains the unrelated member, and adds the replacement instance while sticky `R` remains.

Add ordered requirement tests: `Layer.override(base, requirementFree, requiresReplacementDependency)` must retain only `ReplacementDependency`, while reversing the two compatible overrides must end requirement-free. Add a stateful validation test where the base lacks tag X, the first override introduces `RichX`, and the second override tries incompatible same-tag `LeanX`; mark the whole call `@ts-expect-error`. This proves the second override is validated against state introduced by the first.

Add a type-only base containing one compatible and one incompatible same-tag member:

```ts
declare const ambiguousBase: Layer<RichDatabase | LeanDatabase, never>
const richReplacement = Layer.make(RichDatabase)

// @ts-expect-error one compatible pair cannot hide the incompatible Lean pair
Layer.override(ambiguousBase, richReplacement)
```

This test must fail for contract incompatibility, not an undefined identifier.

Add two different-tag Services with identical method shapes, override one with the other, and assert both provided identities remain represented according to ordinary non-replacement composition semantics. This proves contract shape alone never triggers removal.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
cd packages/better-effect
bun run --silent tsc -- -p tests/types/tsconfig.layer-environments.json
bunx --bun --package typescript@5.7.2 tsc -p tests/types/tsconfig.layer-environments.json
bun run typecheck
```

Expected: FAIL on the new mixed-provenance and adversarial override assertions.

- [ ] **Step 4: Implement precise entry replacement**

In `layer/inference.ts`:

- remove only precise entries with the same literal tag and bidirectionally compatible `Service.Contract`;
- never remove `ErasedStickyRequired` by provider ownership;
- remove from an erased provided union only members with the same literal tag and bidirectionally compatible contract, retain every unrelated/incompatible member, add the replacement provided instances, and keep all sticky requirements;
- add replacement precise/erased channels;
- recompute final external requirements;
- recurse left to right so the final accepted override wins.

Type-level token diagnostics must use `Service.TokenOf<ReplacementProvided>` rather than an entry token parameter.

- [ ] **Step 5: Implement call-site compatibility validation**

Define the package-private diagnostic and result transform contracts first:

```ts
type IncompatibleLayerOverride<Tokens extends AnyServiceToken> = {
  readonly __betterEffectIncompatibleLayerOverride: Tokens
}

type OverrideLayerResult<
  Base extends Layer.Any,
  Overrides extends readonly Layer.Any[]
> = LayerResult<
  ApplyPreciseOverrides<PreciseEntries<Base>, Overrides>,
  ApplyErasedOverrides<ErasedEntries<Base>, Overrides>
>
```

`ApplyPreciseOverrides` recursively removes compatible same-tag precise entries and appends each replacement's precise entries. `ApplyErasedOverrides` recursively updates only the erased provided union, unions replacement erased provenance, and never removes sticky requirements by ownership. Both recurse left to right and use the state returned by the preceding tuple element.

Define `IncompatibleOverridePairs<CurrentProvided, ReplacementProvided>` as a fully distributive pair comparison: return `Service.TokenOf<ReplacementProvided>` only when a pair has the same literal tag and non-bidirectionally-compatible `Service.Contract`; otherwise return `never`. Then define:

```ts
type ValidateOneOverride<Current extends Layer.Any, Replacement extends Layer.Any> = [
  IncompatibleOverridePairs<Layer.Provided<Current>, Layer.Provided<Replacement>>
] extends [never]
  ? unknown
  : IncompatibleLayerOverride<
      IncompatibleOverridePairs<Layer.Provided<Current>, Layer.Provided<Replacement>>
    >

type OverrideResult<Base extends Layer.Any, Replacement extends Layer.Any> = OverrideLayerResult<
  Base,
  readonly [Replacement]
>

type ValidateOverrides<
  Base extends Layer.Any,
  Overrides extends readonly Layer.Any[]
> = Overrides extends readonly [
  infer Head extends Layer.Any,
  ...infer Tail extends readonly Layer.Any[]
]
  ? ValidateOneOverride<Base, Head> & ValidateOverrides<OverrideResult<Base, Head>, Tail>
  : unknown
```

Every concrete same-tag incompatible pair must fail. One compatible pair must not hide another incompatible pair. Intersect validation into the original `const Overrides` tuple using `NoInfer` or an equivalent non-widening pattern.

Delete the old collision generic, collision extraction, and late complete-Layer collision branches.

- [ ] **Step 6: Preserve runtime override behavior**

Do not change the provider Map replacement loop. It must still replace by `serviceTag`, retain the actual winning constructor, and leave backend defensive member checks intact.

- [ ] **Step 7: Run type and runtime regressions**

```bash
cd packages/better-effect
bun run --silent tsc -- -p tests/types/tsconfig.layer-environments.json
bunx --bun --package typescript@5.7.2 tsc -p tests/types/tsconfig.layer-environments.json
bun run typecheck
bunx --bun --package typescript@5.7.2 tsc --noEmit -p tsconfig.json
bun test tests/layer-runtime.test.ts
```

Expected: all PASS.

- [ ] **Step 8: Commit precise override semantics**

```bash
git add \
  packages/better-effect/src/layer/inference.ts \
  packages/better-effect/src/layer/layer.ts \
  packages/better-effect/tests/types/layer-environments.types.ts \
  packages/better-effect/tests/types/service-identity.types.ts
git commit -m "feat: preserve Layer override provenance"
```

---

## Chunk 2: Erasure Safety and Public Package Surface

### Task 4: Classify Layer unions and erasure sentinels before boundaries

**Files:**

- Modify: `packages/better-effect/tests/types/layer-environments.types.ts`
- Modify: `packages/better-effect/tests/types/layer-variance.types.ts`
- Modify: `packages/better-effect/tests/types/runtime.types.ts`
- Modify: `packages/better-effect/src/layer/inference.ts`
- Modify: `packages/better-effect/src/layer/layer.ts`
- Modify: `packages/better-effect/src/layer/runtime.ts`
- Modify: `packages/better-effect/src/runtime/runtime.ts`

- [ ] **Step 1: Add RED tests for concrete Layer unions**

Add:

```ts
declare const concreteUnion: Layer<Database, never> | Layer<Logger, never>

// @ts-expect-error a runtime branch does not guarantee both Services
Layer.merge(concreteUnion)

// @ts-expect-error Runtime cannot flatten a concrete Layer union
void Runtime.make(concreteUnion, {} as never)

// @ts-expect-error createRuntimeHandle rejects the same union
void createRuntimeHandle(concreteUnion, {} as never)
```

Also test one-shot `Runtime.run`, `Layer.override` with the union in the base position, and `Layer.override` with the union in an override-tuple position. Add `Layer<Database, never> | Layer<never, any>` and prove it is rejected because it is not exactly `Layer.Any`. Each call must use the original union directly so inference-widening bypasses are exercised.

- [ ] **Step 2: Add RED tests for exact and partial `any` shapes**

Cover all normative forms:

```ts
declare const unchecked: Layer<any, any>
declare const erasedEmpty: Layer<never, any>
declare const partialRequired: Layer<Database, any>
declare const partialProvided: Layer<any, never>
declare const crossPartial: Layer<any, never> | Layer<never, any>
declare const bare: Layer

type AnyLayer = Layer.Any

void Runtime.make(unchecked, {} as never)
void Runtime.make(erasedEmpty, {} as never)

// @ts-expect-error partial any is not an exact sentinel
void Runtime.make(partialRequired, {} as never)
// @ts-expect-error partial any is not an exact sentinel
void Runtime.make(partialProvided, {} as never)
// @ts-expect-error cross-partial union is not Layer.Any
void Runtime.make(crossPartial, {} as never)
// @ts-expect-error bare Layer remains incomplete
void Runtime.make(bare, {} as never)

expectTypeOf(Layer.merge(unchecked)).toMatchTypeOf<Layer<any, any>>()
expectTypeOf(Layer.merge(erasedEmpty)).toMatchTypeOf<Layer<any, any>>()
```

Use `declare const erasedAlias: Layer.Any` to prove the exact alias remains accepted through merge, override, `Layer.Complete`, and Runtime boundaries. Add:

- `Layer<Service.Any, Service.Any>` and `Layer<Database>` negative completeness tests;
- partial-any rejection through merge, both override positions, `Layer.Complete`, `Runtime.make`, one-shot `Runtime.run`, and `createRuntimeHandle`;
- exact sentinel propagation through both merge and override;
- `Layer.merge(bare)` and `Layer.merge(widenedServiceAny)` remaining incomplete;
- the cross-partial union and an erased-empty-containing concrete union remaining invalid.

Use `expectTypeOf<Layer.Complete<...>>()` diagnostics plus boundary `@ts-expect-error` calls; do not rely only on Runtime.make. Add `const unchanged = Layer.override(DatabaseLive)` and assert its `Provided` and `Required` channels remain exactly `Database` and `never`, covering the empty override tuple.

Add widened provided-environment override negatives in both positions:

```ts
declare const widenedProvided: Layer<Service.Any, never>

// @ts-expect-error widened Service.Any cannot prove base compatibility
Layer.override(widenedProvided, DatabaseLive)
// @ts-expect-error widened Service.Any cannot prove replacement compatibility
Layer.override(DatabaseLive, widenedProvided)
```

These must reject without inference widening to `Layer.Any`; widened `Service.Any` is not an unchecked Layer sentinel.

- [ ] **Step 3: Verify RED without allowing generic widening**

```bash
cd packages/better-effect
bun run --silent tsc -- -p tests/types/tsconfig.layer-environments.json
bunx --bun --package typescript@5.7.2 tsc -p tests/types/tsconfig.layer-environments.json
bun run typecheck
```

Expected: FAIL on the new classification assertions because boundaries currently distribute/flatten Layer unions and do not distinguish exact from partial erasure.

- [ ] **Step 4: Implement original-shape classification**

In `layer/inference.ts`, add package-private named diagnostics and a classifier with this order:

```ts
type LayerInputState<L> =
  IsExactUncheckedLayer<L> extends true
    ? 'unchecked'
    : HasPartialAnyChannel<L> extends true
      ? 'invalid-partial-any'
      : IsConcreteUnion<L> extends true
        ? 'invalid-union'
        : 'typed'
```

Exact unchecked forms are only:

- `Layer<any, any>`;
- `Layer<never, any>`;
- exact `Layer.Any`, currently `Layer<any, any> | Layer<never, any>`.

Do not classify from aggregated `Layer.Provided<L>`/`Layer.Required<L>`; inspect constituents so `Layer<any, never> | Layer<never, any>` remains invalid.

- [ ] **Step 5: Apply validation to original parameters**

Create package-private helpers such as `ValidateLayerInput<L>` and `ValidateLayerTuple<Layers>`. Apply them as intersections to:

- each original `Layer.merge` tuple element;
- `Layer.override` base and each original override tuple element;
- `Runtime.make`'s original `L`;
- one-shot `Runtime.run`'s original `L`;
- `createRuntimeHandle`'s original `L`;
- `Layer.Complete<L>` before checking `Required`.

Use `NoInfer`, tuple intersections, or an equivalent TS 5.7-safe technique so inference cannot widen an invalid union to `Layer.Any`.

- [ ] **Step 6: Implement sentinel propagation and typed completeness**

- composition with any exact sentinel returns an unchecked `Layer<any, any>` result;
- other partial-any shapes receive a named invalid-erasure diagnostic;
- widened `Service.Any` is preserved as an external requirement;
- typed concrete Layers are complete only when `Layer.Required<L>` is exactly `never`;
- recognized exact sentinels bypass only the documented checks;
- typed override validation rejects widened `Service.Any` in either base or replacement provided channels because no literal tag can be proven, using the original non-widened argument types.

Keep Runtime execution's existing `Service.Any` erasure rules unchanged; these stricter rules apply to Layer input classification.

- [ ] **Step 7: Run current and TS 5.7 source checks**

```bash
cd packages/better-effect
bun run --silent tsc -- -p tests/types/tsconfig.layer-environments.json
bunx --bun --package typescript@5.7.2 tsc -p tests/types/tsconfig.layer-environments.json
bun run typecheck
bunx --bun --package typescript@5.7.2 tsc --noEmit -p tsconfig.json
```

Expected: all PASS.

- [ ] **Step 8: Commit Layer input safety**

```bash
git add \
  packages/better-effect/src/layer/inference.ts \
  packages/better-effect/src/layer/layer.ts \
  packages/better-effect/src/layer/runtime.ts \
  packages/better-effect/src/runtime/runtime.ts \
  packages/better-effect/tests/types/layer-environments.types.ts \
  packages/better-effect/tests/types/layer-variance.types.ts \
  packages/better-effect/tests/types/runtime.types.ts
git commit -m "feat: validate Layer unions and erasure sentinels"
```

### Task 5: Add RED package-surface fixtures, then remove old Layer metadata exports

**Files:**

- Create: `packages/better-effect/tests/package/public-type-namespaces/invalid-layer-exports.ts`
- Create: `packages/better-effect/tests/package/public-type-namespaces/tsconfig.invalid-layer-exports.json`
- Modify: `packages/better-effect/tests/package/public-type-namespaces/check.ts`
- Modify: `packages/better-effect/tests/package/public-type-variance/check.ts`
- Modify: `packages/better-effect/src/layer/types.ts`
- Modify: `packages/better-effect/src/layer/layer.ts`
- Modify: `packages/better-effect/src/layer/index.ts`
- Modify: `packages/better-effect/src/index.ts`
- Modify: `packages/better-effect/src/runtime/types.ts`
- Modify: `packages/better-effect/tests/types/public-type-namespaces.types.ts`
- Modify: `packages/better-effect/tests/types/instance-requirements.types.ts`
- Modify: `packages/better-effect/tests/package/public-type-namespaces/valid.ts`
- Modify: `packages/better-effect/tests/package/public-type-variance/valid.ts`

- [ ] **Step 1: Create the failing-import fixture before deleting exports**

Create `invalid-layer-exports.ts`:

```ts
import type {
  AnyLayer,
  AnyLayerSpec,
  CompleteLayer,
  LayerMissing,
  LayerProvided,
  LayerRawRequired,
  LayerSpec,
  LayerSpecs
} from 'better-effect'

void (0 as unknown as AnyLayer)
void (0 as unknown as AnyLayerSpec)
void (0 as unknown as CompleteLayer<never>)
void (0 as unknown as LayerMissing<never>)
void (0 as unknown as LayerProvided<never>)
void (0 as unknown as LayerRawRequired<never>)
void (0 as unknown as LayerSpec<never>)
void (0 as unknown as LayerSpecs<never>)
```

Create `tsconfig.invalid-layer-exports.json` by copying the valid package fixture compiler options and setting `files` to only this source.

- [ ] **Step 2: Make the checker demand removed exports and namespace members are absent**

Extend `public-type-namespaces/check.ts` to run the invalid config with current TypeScript and 5.7.2, require non-zero status, and assert every removed import is rejected at its own source line.

Change the required Layer namespace list to:

```ts
Layer: ['Any', 'Provided', 'Required', 'Complete']
```

Separately assert that the emitted Layer namespace body contains neither `type Specs` nor `type Missing`; removing them from the positive list alone is insufficient. Add all eight top-level removed names to the stale public-export scan.

- [ ] **Step 3: Build and verify RED**

```bash
cd packages/better-effect
bun run build
bun run check:public-type-namespaces
```

Expected: FAIL because the old top-level exports and `Layer.Specs`/`Layer.Missing` still exist, so the negative fixture unexpectedly compiles or the explicit stale-member assertion fails.

- [ ] **Step 4: Remove old names from source and public barrels**

Delete the temporary compatibility declarations and all public exports for:

```ts
LayerSpec
AnyLayerSpec
LayerSpecs
AnyLayer
LayerProvided
LayerRawRequired
LayerMissing
CompleteLayer
```

Remove namespace members `Layer.Specs` and `Layer.Missing`. Keep only `Layer.Any`, `Layer.Provided`, `Layer.Required`, and `Layer.Complete`. Do not export provenance helpers or Layer input diagnostics.

- [ ] **Step 5: Migrate every remaining source and source-test import**

Use `Layer.Provided`, `Layer.Required`, and `Layer.Complete`. Explicitly update `instance-requirements.types.ts` in addition to namespace, Layer, scoped-generator, identity, variance, and Runtime tests. Package-private modules may import focused internal aliases, but those aliases must not cross a public barrel.

Change `RuntimeFor` to constrain its input through the internal Layer shape while its result remains:

```ts
Runtime<Layer.Provided<L>>
```

- [ ] **Step 6: Update source namespace and built variance contracts**

Use exact public assertions:

```ts
expectTypeOf<Layer.Any>().toEqualTypeOf<Layer<any, any> | Layer<never, any>>()
expectTypeOf<Layer.Provided<typeof AppLive>>().toEqualTypeOf<Database | Repository>()
expectTypeOf<Layer.Required<typeof AppLive>>().toBeNever()
expectTypeOf<Layer.Complete<typeof AppLive>>().toEqualTypeOf<typeof AppLive>()
```

Replace `DatabaseSpec`/`LoggerSpec` in `public-type-variance/valid.ts` with instance channels. Update `public-type-variance/check.ts` so declaration inspection expects `Layer<Provided, Required>`, not `LayerSpec` or collision generics. Add required-channel covariance and partial-any rejection coverage.

- [ ] **Step 7: Run namespace, variance, and full type checks**

```bash
cd packages/better-effect
bun run typecheck
bunx --bun --package typescript@5.7.2 tsc --noEmit -p tsconfig.json
bun run build
bun run check:public-type-namespaces
bun run check:public-type-variance
```

Expected: all PASS with current compiler and TypeScript 5.7.2; the invalid export fixture now fails exactly as asserted.

- [ ] **Step 8: Commit the reduced public surface and its RED/GREEN fixture**

```bash
git add \
  packages/better-effect/src/layer/types.ts \
  packages/better-effect/src/layer/layer.ts \
  packages/better-effect/src/layer/index.ts \
  packages/better-effect/src/index.ts \
  packages/better-effect/src/runtime/types.ts \
  packages/better-effect/tests/types/public-type-namespaces.types.ts \
  packages/better-effect/tests/types/instance-requirements.types.ts \
  packages/better-effect/tests/package/public-type-namespaces/invalid-layer-exports.ts \
  packages/better-effect/tests/package/public-type-namespaces/tsconfig.invalid-layer-exports.json \
  packages/better-effect/tests/package/public-type-namespaces/check.ts \
  packages/better-effect/tests/package/public-type-namespaces/valid.ts \
  packages/better-effect/tests/package/public-type-variance/check.ts \
  packages/better-effect/tests/package/public-type-variance/valid.ts
git commit -m "feat: remove public Layer spec metadata"
```

### Task 6: Lock the remaining built-package declaration contract

**Files:**

- Modify: `packages/better-effect/tests/package/public-type-namespaces/valid.ts`
- Modify: `packages/better-effect/tests/package/instance-requirements/valid.ts`
- Modify: `packages/better-effect/tests/package/instance-requirements/check.ts`
- Modify: `packages/better-effect/tests/package/public-type-namespaces/check.ts`

- [ ] **Step 1: Add built consumer examples for the new Layer spelling**

First migrate `tests/package/instance-requirements/valid.ts`: remove `LayerProvided` and `LayerMissing` imports and replace its existing aliases with:

```ts
export type Provided = Expect<Equal<Layer.Provided<typeof AppLive>, Database | Logger>>
export type Required = Expect<Equal<Layer.Required<typeof AppLive>, never>>
```

In `public-type-namespaces/valid.ts`, use its existing `Repository` and include:

```ts
const RepositoryLive = Layer.make(Repository) satisfies Layer<Repository, Database>
const AppLive = Layer.merge(DatabaseLive, RepositoryLive)

type AppProvided = Expect<Equal<Layer.Provided<typeof AppLive>, Database | Repository>>
type AppRequired = Expect<Equal<Layer.Required<typeof AppLive>, never>>
```

Use `satisfies`, not a `:` annotation, where later composition must retain inferred provenance.

Also add built-package coverage for mixed precise/erased provenance using existing fixture Services or small local Services. The assertions must prove that overriding a precise provider removes its precise acquisition requirement while overriding an explicitly annotated provider retains its sticky requirement. Add two same-tag Rich/Lean fixture Services and:

```ts
// @ts-expect-error incompatible same-tag overrides fail at the call site
Layer.override(RichLive, LeanLive)
```

These declarations are compiled by both current TypeScript and 5.7.2 through the package checks. Use the fixture's exact Service method contracts rather than placeholder methods.

- [ ] **Step 2: Extend runtime metadata leakage checks**

Add `LayerProvenanceTypeId` and any final package-private classification symbol names to the generated ESM marker list in `instance-requirements/check.ts` and `public-type-namespaces/check.ts`.

- [ ] **Step 3: Verify the built package with both compilers**

```bash
cd packages/better-effect
bun run build
bun run check:public-type-namespaces
bun run check:public-type-variance
bun run check:instance-requirements
bun run publint
```

Expected: all PASS.

- [ ] **Step 4: Commit package declaration coverage**

```bash
git add \
  packages/better-effect/tests/package/public-type-namespaces/check.ts \
  packages/better-effect/tests/package/public-type-namespaces/valid.ts \
  packages/better-effect/tests/package/instance-requirements/valid.ts \
  packages/better-effect/tests/package/instance-requirements/check.ts
git commit -m "test: lock Layer environment declarations"
```

---

## Chunk 3: Runtime Regression, Documentation, and Acceptance

### Task 7: Prove runtime behavior remains constructor-backed

**Files:**

- Modify: `packages/better-effect/tests/layer-runtime.test.ts`
- Modify: `packages/better-effect/tests/public-api.test.ts`

- [ ] **Step 1: Add a focused runtime registration assertion**

Add a test that builds a Layer whose inferred public type is `Layer<UserRepository, Database>`, supplies Database through merge, and records registrations in a test backend. Assert registrations receive the exact class constructors:

```ts
expect(registeredTokens).toEqual([Database, UserRepository])
```

Also assert no instance-side or provenance marker is an own property of constructed Services or Layer values.

- [ ] **Step 2: Keep override runtime replacement coverage**

Ensure an existing or new test proves `Layer.override` registers only the winning constructor for a tag and preserves release behavior. Do not move release callbacks into the backend.

- [ ] **Step 3: Update public API runtime assertions**

`public-api.test.ts` should continue to assert only intended runtime exports. Type-only namespace members and provenance helpers must not appear as runtime properties or root exports.

- [ ] **Step 4: Run runtime tests**

```bash
cd packages/better-effect
bun test tests/layer-runtime.test.ts tests/public-api.test.ts
bun test
```

Expected: 146 or more tests PASS, 0 failures. The exact total may increase with the new regression tests.

- [ ] **Step 5: Commit runtime regressions**

```bash
git add \
  packages/better-effect/tests/layer-runtime.test.ts \
  packages/better-effect/tests/public-api.test.ts
git commit -m "test: preserve constructor-backed Layer runtime"
```

### Task 8: Migrate README, docs, project guidance, and current specs

**Files:**

- Modify: `packages/better-effect/README.md`
- Modify: `apps/docs/content/docs/getting-started.mdx`
- Modify: `apps/docs/content/docs/index.mdx`
- Modify: `apps/docs/content/docs/layers.mdx`
- Modify: `apps/docs/content/docs/runtime.mdx`
- Modify: `apps/docs/content/docs/services.mdx`
- Modify: `apps/docs/content/docs/testing.mdx`
- Modify: `apps/docs/content/docs/troubleshooting.mdx`
- Modify: `AGENTS.md`
- Modify: `openspec/specs/typed-layer-requirements/spec.md`
- Modify: `openspec/specs/typed-runtime-execution-requirements/spec.md`
- Modify if references remain: `openspec/specs/service-identity/spec.md`
- Do not modify: `openspec/changes/archive/**`

- [ ] **Step 1: Replace public Layer examples**

Use the canonical examples consistently:

```ts
const RepositoryLive = Layer.gen(UserRepository, async function* () {
  const database = yield* Database
  return new UserRepository(database)
})
// Layer<UserRepository, Database>

const AppLive = Layer.merge(Layer.make(Database), RepositoryLive)
// Layer<Database | UserRepository, never>
```

Explain that `Required` is external after composition, not raw per-provider metadata.

- [ ] **Step 2: Document inference and `satisfies`**

Recommend:

```ts
const AppLive = Layer.merge(...)
```

or:

```ts
const AppLive = Layer.merge(...) satisfies Layer<AppServices, never>
```

Explain briefly that a `:` annotation preserves safety but erases per-provider provenance, making later overrides conservative.

- [ ] **Step 3: Document override and union behavior**

State:

- inferred compatible overrides remove only the replaced provider's acquisition requirements;
- incompatible same-tag replacements fail at `Layer.override`;
- concrete `Layer<A> | Layer<B>` values must be narrowed before composition/Runtime creation;
- `Layer.Any` is the explicit unchecked generic boundary;
- bare/one-argument Layers and partial-`any` shapes are not unchecked.

- [ ] **Step 4: Update AGENTS invariants**

Replace the `LayerSpec<Provided, Required, Token>` public model with:

```ts
Layer<Provided, Required>
```

Record these invariants:

- runtime providers retain actual constructors;
- type-level tokens derive from `Service.TokenOf<Provided>`;
- opaque precise/sticky provenance is package-private;
- `Required` is external;
- incompatible overrides fail at the call site;
- concrete Layer unions are rejected;
- archived OpenSpec files remain untouched.

Remove guidance naming `Layer.Missing`, raw top-level aliases, and late collision generics.

- [ ] **Step 5: Update current OpenSpec contracts directly**

In `typed-layer-requirements/spec.md`, replace requirements for public specs/exact token channels with the two-channel environment, opaque provenance, external requirements, sticky erasure, call-site collisions, and union rejection.

In `typed-runtime-execution-requirements/spec.md`, use `Layer.Provided<L>`, `Layer.Required<L>`, and `Layer.Complete<L>`, including concrete-union rejection and exact sentinel behavior.

Update `service-identity/spec.md` wherever it says Layer publicly retains exact constructors or defers incompatible override failure to a complete-Layer boundary. Runtime registration still retains actual constructors, the Layer type no longer exposes them, and incompatible same-tag contracts now fail directly at `Layer.override`.

- [ ] **Step 6: Verify no stale public names remain outside design/history**

Run fail-fast scans:

```bash
STALE='LayerSpec|AnyLayerSpec|LayerSpecs|Layer\.Specs|Layer\.Missing|AnyLayer|LayerProvided|LayerMissing|LayerRawRequired|CompleteLayer'
if rg -n "$STALE" AGENTS.md packages/better-effect/README.md apps/docs/content/docs openspec/specs; then
  exit 1
fi
if rg -n "export type.*($STALE)|export \{.*($STALE)" \
  packages/better-effect/src/index.ts packages/better-effect/src/layer/index.ts; then
  exit 1
fi
```

Expected: exit 0. Package-private implementation helpers may use different internal names; historical design/plan documents and archived OpenSpec changes are excluded.

Inspect the executable example explicitly:

```bash
if rg -n "Layer<|LayerSpec|AnyLayerSpec|LayerSpecs|Layer\.Specs|Layer\.Missing|AnyLayer|LayerProvided|LayerRawRequired|LayerMissing|CompleteLayer" \
  packages/better-effect/examples/todo-api; then
  echo "Migrate every stale example annotation above" >&2
  exit 1
fi
```

Migrate any annotation found; otherwise record that inference-only example usage needs no source change.

- [ ] **Step 7: Run docs and example checks**

```bash
bun run typecheck
bun run docs:build
```

Expected: both PASS.

- [ ] **Step 8: Commit documentation and current specs**

```bash
git add \
  AGENTS.md \
  packages/better-effect/README.md \
  apps/docs/content/docs/getting-started.mdx \
  apps/docs/content/docs/index.mdx \
  apps/docs/content/docs/layers.mdx \
  apps/docs/content/docs/runtime.mdx \
  apps/docs/content/docs/services.mdx \
  apps/docs/content/docs/testing.mdx \
  apps/docs/content/docs/troubleshooting.mdx \
  openspec/specs/typed-layer-requirements/spec.md \
  openspec/specs/typed-runtime-execution-requirements/spec.md \
  openspec/specs/service-identity/spec.md \
  packages/better-effect/examples/todo-api
git commit -m "docs: describe Layer provided and required environments"
```

### Task 9: Complete acceptance verification and branch review

**Files:**

- Modify only files required to fix failures caused by this change.
- Do not broaden into unrelated lint cleanup.

- [ ] **Step 1: Format all changed files**

```bash
cd packages/better-effect
bun run format
cd ../..
bunx oxfmt --check \
  AGENTS.md \
  packages/better-effect/README.md \
  apps/docs/content/docs \
  openspec/specs \
  docs/superpowers/specs/2026-08-17-layer-provided-required-design.md \
  docs/superpowers/plans/2026-08-17-layer-provided-required.md
git diff --check
```

Expected: Oxfmt checks every changed source/documentation area, including files outside the package workspace, and no whitespace errors remain.

- [ ] **Step 2: Run the complete acceptance matrix**

```bash
bun run typecheck
bun test
bun run build
cd packages/better-effect
bun run check:public-type-namespaces
bun run check:public-type-variance
bun run check:instance-requirements
bun run publint
cd ../..
bun run docs:build
git diff --check
```

Expected: every command PASS. Package fixtures must report current TypeScript and TypeScript 5.7.2 success.

- [ ] **Step 3: Run the project aggregate check and compare lint as a multiset**

```bash
bunx turbo run check --filter=@better-effect/docs
set +e
bun run check > /tmp/better-effect-layer-check.log 2>&1
CHECK_STATUS=$?
cd packages/better-effect
bun run lint > /tmp/better-effect-layer-lint-current.log 2>&1
LINT_STATUS=$?
cd ../..
set -e
printf '%s\n' "$CHECK_STATUS" > /tmp/better-effect-layer-check.status
printf '%s\n' "$LINT_STATUS" > /tmp/better-effect-layer-lint-current.status
python3 - <<'PY'
import re
from collections import Counter
from pathlib import Path

pattern = re.compile(r'^(.*?):\d+:\d+: error ([^:]+): (.*)$')

def diagnostics(path: str) -> Counter[tuple[str, str, str]]:
    rows = Counter()
    for line in Path(path).read_text(errors='ignore').splitlines():
        match = pattern.match(line)
        if match:
            rows[match.groups()] += 1
    return rows

baseline = diagnostics('/tmp/better-effect-layer-lint-baseline.log')
current = diagnostics('/tmp/better-effect-layer-lint-current.log')
check_status = int(Path('/tmp/better-effect-layer-check.status').read_text().strip())
lint_status = int(Path('/tmp/better-effect-layer-lint-current.status').read_text().strip())
added = current - baseline

if not baseline:
    raise SystemExit('Baseline lint log contained no parseable diagnostics')
if lint_status != 0 and not current:
    raise SystemExit('Lint failed without parseable diagnostics; possible tool crash')
if check_status == 0 and lint_status != 0:
    raise SystemExit('Aggregate passed while the same-tree direct lint failed')
if check_status != 0 and lint_status == 0:
    raise SystemExit('Aggregate check failed for a reason other than lint debt')
if added:
    for item, count in sorted(added.items()):
        print(f'ADDED x{count}: {item}')
    raise SystemExit(1)

print(
    f'check_status={check_status} lint_status={lint_status} '
    f'baseline={sum(baseline.values())} current={sum(current.values())} added=0'
)
PY
CHECK_STATUS=$(cat /tmp/better-effect-layer-check.status)
if [ "$CHECK_STATUS" -ne 0 ] && ! rg -q 'script "lint" exited with code 1' /tmp/better-effect-layer-check.log; then
  echo 'Aggregate check did not end in the documented lint failure' >&2
  exit 1
fi
```

The isolated docs workspace check must pass before the aggregate run. Together with Step 2's individual package gates, this ensures an aggregate failure cannot hide an additional workspace failure. If `bun run check` passes, record that result. If it exits nonzero, inspect `/tmp/better-effect-layer-check.log` and accept only the known final package lint failure with `added=0`; do not claim the aggregate check passed. A multiset comparison is required so a new duplicate violation in an already affected file cannot be hidden.

- [ ] **Step 4: Verify archived OpenSpec files are untouched**

```bash
BASE=$(cat /tmp/better-effect-layer-implementation-base)
git diff --exit-code "$BASE"..HEAD -- openspec/changes/archive
git diff --exit-code -- openspec/changes/archive
git diff --cached --exit-code -- openspec/changes/archive
```

Expected: all exit 0 with no output.

- [ ] **Step 5: Commit formatter output before review if needed**

```bash
git status --short
```

If Step 1 changed tracked files, inspect every diff, rerun the affected acceptance commands, stage only those formatted files, and commit:

```bash
git commit -m "style: format Layer environment changes"
```

If there are unexpected or unrelated changes, stop instead of including them. The worktree must be clean before requesting review so `"$BASE"..HEAD` covers every implementation byte.

- [ ] **Step 6: Request final code review**

Set the review range from the recorded implementation base:

```bash
BASE=$(cat /tmp/better-effect-layer-implementation-base)
git log --oneline "$BASE"..HEAD
```

Use `superpowers:requesting-code-review` with `"$BASE"..HEAD` and ask the reviewer to check:

- two-parameter public Layer API;
- external requirement calculation;
- exact vs erased provenance;
- union/partial-any safety under TS 5.7;
- non-widening override and Runtime constraints;
- absence of removed public exports;
- unchanged runtime lifecycle behavior.

Resolve blocking findings, commit the fixes, then rerun every final gate in Steps 1–4: formatting, complete acceptance matrix, aggregate/direct lint multiset comparison, and archived OpenSpec checks. If review fixes materially change type-level validation or runtime behavior, request a second review of the updated `"$BASE"..HEAD` range before completion.

- [ ] **Step 7: Commit any review fixes**

Stage only reviewed files and use a focused message, for example:

```bash
git commit -m "fix: close Layer environment type gaps"
```

Skip this step if review requires no changes.

- [ ] **Step 8: Confirm clean status and summarize evidence**

```bash
git status --short
git log --oneline --decorate -8
git diff --check
```

Expected: clean working tree, focused commits, and no whitespace errors.

- [ ] **Step 9: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`. Do not merge, push, or delete the branch without the user's explicit choice.

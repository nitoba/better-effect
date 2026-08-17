# Public Type Namespaces Design

## Summary

Add type-only namespaces to the five main public APIs of `better-effect` through TypeScript declaration merging. The change groups existing public type helpers under their associated runtime values while preserving every current prefixed type export.

The new API supports:

```ts
type Dependencies = Effect.Requirements<typeof program>
type Services = Layer.Provided<typeof AppLive>
type AppRuntime = Runtime.For<typeof AppLive>
type Tag = Service.Tag<typeof Database>
type Outcome = Scope.Outcome
```

The namespaces are declaration-only. They must not add runtime objects, namespace wrappers, IIFEs, side effects, or a new execution representation.

## Goals

- Improve autocomplete discovery for public type helpers.
- Group type helpers with the public concepts they describe.
- Preserve the existing ESM architecture and tree-shaking behavior.
- Keep all existing prefixed type exports source-compatible and undeprecated.
- Verify consumption with TypeScript 5.2.2 and the current project compiler.
- Verify generated declarations expose the aliases while generated JavaScript does not.

## Non-goals

- Do not move implementation code into TypeScript namespaces.
- Do not add runtime members for type helpers.
- Do not introduce module augmentation.
- Do not reorganize the package into ESM module namespace exports.
- Do not change Effect, Service, Layer, Runtime, Scope, lifecycle, resolution, or diagnostic semantics.
- Do not remove or deprecate existing prefixed type exports from the package root.
- Do not promote source-internal prefixed helpers to new top-level package exports.
- Do not add aliases beyond the approved public families in this design.

## API

Each new alias delegates to an existing source type, which remains the source of truth. Existing prefixed types already exported from the package root remain public compatibility spellings. `AnyLayer` and `CompleteLayer` currently exist only in the source-level Layer barrel, not the package root; `Layer.Any` and `Layer.Complete` expose those concepts publicly without adding new top-level `AnyLayer` or `CompleteLayer` exports.

### Effect

The `Effect` value gains a declaration-only merged namespace with:

| New alias                | Existing source type    |
| ------------------------ | ----------------------- |
| `Effect.Success<T>`      | `EffectSuccess<T>`      |
| `Effect.Error<T>`        | `EffectError<T>`        |
| `Effect.Requirements<T>` | `EffectRequirements<T>` |
| `Effect.AnyResult`       | `AnyEffectResult`       |

`EffectResult` remains top-level. The project does not expose a runtime `Effect<A, E, R>` value, so aliases such as `Effect.Effect` or `Effect.Result` would communicate the wrong execution model.

### Service

The `Service` function gains a declaration-only merged namespace with:

| New alias                      | Existing source type          |
| ------------------------------ | ----------------------------- |
| `Service.Any`                  | `AnyServiceToken`             |
| `Service.Token<Tag, Instance>` | `ServiceToken<Tag, Instance>` |
| `Service.Class<Tag, Instance>` | `ServiceClass<Tag, Instance>` |
| `Service.Instance<T>`          | `ServiceInstance<T>`          |
| `Service.Tag<T>`               | `ServiceTag<T>`               |
| `Service.Requirements<T>`      | `ServiceRequirements<T>`      |

The generic defaults and constraints must match the existing source types so the aliases neither strengthen nor weaken their contracts. In particular, `Service.Token` and `Service.Class` retain `Tag extends string = string` and `Instance = any`; `Service.Instance`, `Service.Tag`, and `Service.Requirements` retain their `T extends AnyServiceToken` constraint.

### Layer

The `Layer` class gains a declaration-only merged namespace with:

| New alias           | Existing source type  |
| ------------------- | --------------------- |
| `Layer.Any`         | `AnyLayer`            |
| `Layer.Specs<L>`    | `LayerSpecs<L>`       |
| `Layer.Provided<L>` | `LayerProvided<L>`    |
| `Layer.Required<L>` | `LayerRawRequired<L>` |
| `Layer.Missing<L>`  | `LayerMissing<L>`     |
| `Layer.Complete<L>` | `CompleteLayer<L>`    |

`Required` is the shorter namespaced spelling for the existing raw provider requirements. Its semantics do not change. Every generic Layer helper retains `L extends AnyLayer`. `Layer.Any` and `Layer.Complete` do not imply new top-level package exports for the source-only `AnyLayer` and `CompleteLayer` names.

### Runtime

The `Runtime` class gains a declaration-only merged namespace with:

| New alias                    | Existing source type        |
| ---------------------------- | --------------------------- |
| `Runtime.For<L>`             | `RuntimeFor<L>`             |
| `Runtime.Options`            | `RuntimeOptions`            |
| `Runtime.ShutdownDiagnostic` | `RuntimeShutdownDiagnostic` |

`Runtime.For<L>` must retain the same typed execution checks as `RuntimeFor<L>` and `Runtime<LayerProvided<L>>`. An unparameterized `Runtime` remains the intentional unchecked escape hatch described by the project architecture.

### Scope

The `Scope` value gains a declaration-only merged namespace with:

| New alias          | Existing source type |
| ------------------ | -------------------- |
| `Scope.Closeable`  | `CloseableScope`     |
| `Scope.Outcome`    | `ScopeOutcome`       |
| `Scope.Finalizer`  | `ScopeFinalizer`     |
| `Scope.Disposable` | `DisposableResource` |

These aliases do not make Scope a Service requirement and do not alter Scope ownership.

## Architecture

Place each `export declare namespace` in the same module as the runtime symbol it merges with:

- `packages/better-effect/src/effect/effect.ts`
- `packages/better-effect/src/service/service.ts`
- `packages/better-effect/src/layer/layer.ts`
- `packages/better-effect/src/runtime/runtime.ts`
- `packages/better-effect/src/scope/scope.ts`

The declaration follows its associated exported value, function, or class. Each module imports the existing source types using `import type`. Existing barrel exports continue to export the merged symbol without module augmentation or a separate namespace facade.

This placement also preserves source-level submodule imports used by the test suite. Root package consumers receive the same merged declarations through `packages/better-effect/src/index.ts` and the generated package declaration entrypoint.

## Runtime and Build Constraints

The namespaces must use `declare` and contain types only. TypeScript must erase them from JavaScript output. The `tsdown` ESM build must remain free of namespace-generated wrappers and runtime alias properties.

The package remains:

- ESM;
- `sideEffects: false`;
- tree-shakeable;
- free of a runtime dependency on TypeScript;
- free of new runtime dependencies.

## Type Safety and Diagnostics

Every namespaced alias must be exactly equal to its existing prefixed counterpart for representative public programs, Services, Layers, Runtimes, and Scopes.

The aliases must preserve:

- exact Service instance inference;
- literal Service tags;
- Effect requirement unions;
- Layer provided, required, missing, and complete contracts;
- Runtime environment checks;
- existing missing-Service diagnostic property names, including literal tags.

The compatibility fixture must include an intentionally invalid Runtime program and confirm that compiler output still contains the relevant `__betterEffectMissingRuntimeService__<Tag>` diagnostic.

## Testing Strategy

### Source type tests

Add `packages/better-effect/tests/types/public-type-namespaces.types.ts`. It imports the public symbols and available prefixed package-root types, then verifies exact equality with `expectTypeOf(...).toEqualTypeOf<...>()` for every approved alias. `Layer.Any` and `Layer.Complete` are compared to their structural contracts because their source types are intentionally not promoted to package-root exports.

The test also verifies omitted defaults for `Service.Token` and `Service.Class`. `@ts-expect-error` cases reject non-string Service tags, non-Service arguments to constrained Service aliases, non-Layer arguments to Layer helpers, and non-Layer arguments to `Runtime.For`.

Follow TDD:

1. add the source type test;
2. run the focused package typecheck and observe failure because the namespaces do not exist;
3. add the minimal declaration-only namespaces;
4. rerun the focused typecheck and confirm success.

No runtime behavior test is needed for aliases that cannot exist at runtime. Artifact checks cover accidental runtime emission.

### Built-package consumer fixture

Add a package-consumer fixture at `packages/better-effect/tests/package/public-type-namespaces/`:

- `valid.ts` imports only from `better-effect` and references every approved namespaced alias;
- `invalid-runtime.ts` runs a Cache-requiring program against a Database-only Runtime and intentionally fails without `@ts-expect-error`;
- `tsconfig.json` compiles only `valid.ts` with `noEmit`, empty ambient `types`, and package-compatible ESM/bundler resolution;
- `tsconfig.diagnostic.json` compiles only `invalid-runtime.ts` to expose the diagnostic text;
- `check.ts` coordinates built-artifact and expected-diagnostic assertions.

The fixture runs only after `tsdown` produces `packages/better-effect/dist`. Its bare `better-effect` self-reference must resolve through the package `exports` entry to `dist/index.mjs` and its adjacent `dist/index.d.mts`; it must not import private source files or use path aliases to `src`.

Compile `valid.ts` with these package scripts:

```json
{
  "test:package-types": "tsc -p tests/package/public-type-namespaces/tsconfig.json",
  "test:package-types:minimum": "bunx --bun --package typescript@5.2.2 tsc --version && bunx --bun --package typescript@5.2.2 tsc -p tests/package/public-type-namespaces/tsconfig.json"
}
```

The local `tsc` command represents the current project compiler. The pinned `bunx` command must report TypeScript 5.2.2 and prevents accidental use of a newer workspace compiler.

The valid fixture verifies both availability and representative exact behavior for every alias, including Service defaults and the equivalence of `Runtime.For<typeof AppLive>` to `Runtime<Layer.Provided<typeof AppLive>>`.

`check.ts` runs the local compiler against `tsconfig.diagnostic.json`, requires a non-zero exit, and requires stderr/stdout to contain `__betterEffectMissingRuntimeService__Cache`.

### Artifact validation

After build, `packages/better-effect/tests/package/public-type-namespaces/check.ts` inspects the root declaration graph (`dist/index.d.mts` plus the local `.d.mts` chunks it references) and all generated ESM chunks, then imports the built ESM entrypoint. Declaration bundling may place shared `Service` and `Layer` definitions in generated chunks, so textual checks cover the complete local declaration and JavaScript graphs while the consumer fixture proves that the root entrypoint exposes them. The checker confirms:

1. all five merged namespace declarations and every approved alias exist in the generated declaration graph;
2. generated ESM contains no namespace IIFE pattern or assignments such as `Effect.Success`, `Layer.Provided`, or equivalent approved alias members;
3. none of the approved type aliases is an own runtime property of the imported `Effect`, `Service`, `Layer`, `Runtime`, or `Scope` value;
4. the intentionally invalid fixture retains the literal Cache diagnostic.

The checker fails with a specific message naming the missing declaration, unexpected runtime member, emitted wrapper, or missing diagnostic. The existing subsequent `publint` and package dry-run CI steps validate the general package shape and inclusion of `dist/index.d.mts`.

The package adds `check:public-type-namespaces`, which runs the current-compiler fixture, the pinned TypeScript 5.2.2 fixture, and `check.ts`. It assumes `dist` has already been built.

### Existing lint baseline

At planning time, the repository-wide `bun run lint` already fails on pre-existing anti-slop diagnostics across source, tests, and examples. This change must not expand into an unrelated lint migration. Capture the baseline before implementation, lint newly created files directly, inspect diagnostics on changed lines, and rerun the full lint/check commands at completion. Report the unchanged baseline separately instead of claiming that this feature caused or fixed it.

All other focused feature checks, typechecks, tests, builds, package checks, documentation builds, and formatting checks must pass. No new lint diagnostic may be introduced by the namespace change.

### CI

Add a post-build step in `.github/workflows/ci.yml` with `working-directory: packages/better-effect` that runs:

```bash
bun run check:public-type-namespaces
```

Keep the existing quality commands and Bun-based workflow. Move the existing lint step to the end of the quality job so the known failing baseline does not prevent build, namespace validation, `publint`, and package inspection from executing; lint remains an unsuppressed failing boundary. The checker provides namespace-specific assertions before the general package checks.

## Documentation

Update the public documentation to recommend namespaced aliases while documenting the prefixed types as compatibility spellings:

- `packages/better-effect/README.md`
- `apps/docs/content/docs/effects.mdx`
- `apps/docs/content/docs/services.mdx`
- `apps/docs/content/docs/layers.mdx`
- `apps/docs/content/docs/runtime.mdx`
- `apps/docs/content/docs/scope.mdx`
- `apps/docs/content/docs/troubleshooting.mdx`

Update the TODO API example to name its Runtime with `Runtime.For<typeof AppLive>`. Keep the old `RuntimeFor` export available, but remove the example-only need to reexport it. Add a focused example TypeScript project so `server.ts` is actually compiled; preserve omission of the optional PATCH title while trimming present values rather than weakening `exactOptionalPropertyTypes`.

Update `AGENTS.md` so internal project guidance recognizes `Runtime.For` as the preferred associated spelling and `RuntimeFor` as the compatible top-level spelling.

Documentation must state that the aliases are type-only and have no runtime or bundle effect.

## Compatibility

This is an additive public API change:

- existing imports continue to compile;
- existing generated JavaScript behavior is unchanged;
- current prefixed aliases remain public and undeprecated;
- TypeScript 5.2.2 and the current compiler can consume the package;
- no consumer migration is required.

## Acceptance Criteria

- All approved namespaced aliases are available from the public package entrypoint.
- Every alias is exactly equal to its existing prefixed source type.
- Existing prefixed exports remain available and undeprecated.
- TypeScript 5.2.2 compiles the valid built-package fixture.
- The current project compiler compiles the valid built-package fixture.
- The invalid fixture retains the literal missing-Service diagnostic tag.
- Generated declarations contain the namespaces and aliases.
- Generated ESM contains no runtime namespace implementation or alias properties.
- README, docs, troubleshooting guidance, `AGENTS.md`, and TODO API example use or explain the new API.
- `bun run check` is executed; all feature-relevant checks pass, and its pre-existing repository lint failures are recorded without new diagnostics from this change.
- Focused formatting checks for every changed file pass.
- `publint` and package dry-run inspection pass.

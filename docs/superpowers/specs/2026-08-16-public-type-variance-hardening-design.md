# Public Type Variance Hardening Design

## Summary

Harden the compile-time relationship between Service tokens, Layer metadata, and the runtime wiring represented by those types.

The change closes two unsafe assignability paths:

1. a `ServiceToken` or `ServiceClass` can currently widen its instance contract because `ServiceStatics.of` uses method syntax and method parameters are bivariant;
2. a `Layer` can currently widen its provider specification union and claim to provide Services that do not exist in its runtime provider collection.

The implementation uses structural variance markers together with explicit `in` and `out` annotations. The markers remain type-only and add no JavaScript behavior.

## Goals

- Make the instance channel of `ServiceToken<Tag, Instance>` and `ServiceClass<Tag, Instance>` invariant.
- Keep the Service tag channel covariant.
- Make `Layer<Specs, Collisions>` invariant in `Specs` and covariant in `Collisions`.
- Document and validate the existing covariance of `LayerSpec` and `ServiceRequirement`.
- Preserve exact Service inference, structural Service implementations through `Service.of`, and existing runtime behavior.
- Verify the public declaration contract with TypeScript 5.2.2 and the current project compiler.

## Non-goals

- Do not change `Runtime<Provided>` variance in this change.
- Do not change the `EffectResult` representation or add runtime metadata to Results.
- Do not change `SameServiceContract` or method-contract normalization.
- Do not add `Symbol.for` protocol identities or public runtime guards.
- Do not replace string-literal `serviceTag` identity.
- Do not add new public type utilities or runtime dependencies.

## Current Problems

### Service instance widening

`ServiceStatics` currently declares `of` with method syntax:

```ts
type ServiceStatics<Tag extends string, Instance> = {
  readonly name: string
  readonly serviceTag: Tag

  of(this: void, implementation: Instance): Instance
}
```

TypeScript checks method parameters bivariantly, including under `strictFunctionTypes`. A narrower Service class can therefore be widened to a broader instance contract while retaining the narrower constructor as its runtime value.

For same-tag Services such as `DogService` and `AnimalService`, the widened token can let `Layer.succeed` register an `AnimalService` instance under the runtime `DogService` constructor. Resolution then remains typed as `DogService`, even though the instance need not implement its additional members.

### Layer provider widening

`Layer` currently carries its phantom metadata in readonly properties:

```ts
declare readonly [LayerTypeId]: Specs
declare readonly [LayerCollisionTypeId]: Collisions
```

Both parameters are therefore structurally covariant. A concrete `Layer<DatabaseSpec>` can be widened to `Layer<DatabaseSpec | LoggerSpec>`. Layer inference then extracts `Logger` as provided even though no Logger provider exists in the runtime collection.

This violates the typed execution invariant that the Services visible in the Runtime type correspond to the providers constructed by its Layer.

## Variance Model

The focused change establishes this model:

```text
ServiceToken<Tag, Instance>
├── Tag: covariant
└── Instance: invariant

LayerSpec<Provided, Required>
├── Provided: covariant
└── Required: covariant

Layer<Specs, Collisions>
├── Specs: invariant
└── Collisions: covariant

ServiceRequirement<Service>
└── Service: covariant
```

`Layer.Specs` is exact because both adding and removing provider specifications can change merge, override, collision, completeness, and execution behavior.

`Layer.Collisions` remains covariant. Widening `never` to a collision can reject a healthy Layer conservatively, while narrowing an actual collision to `never` remains forbidden.

## Internal Variance Utilities

Add a type-only internal module:

```ts
// packages/better-effect/src/internal/variance.ts

export type Covariant<A> = () => A

export type Invariant<A> = (value: A) => A
```

The module is not exported from the package root or a public subpath. It contains only the helpers used by this focused change.

## Service Contract

### Structural contract

Change `ServiceStatics` to an explicitly annotated object type whose `of` member is a function property:

```ts
declare const ServiceVarianceTypeId: unique symbol

interface ServiceVariance<out Tag extends string, in out Instance> {
  readonly _Tag: Covariant<Tag>
  readonly _Instance: Invariant<Instance>
}

type ServiceStatics<out Tag extends string, in out Instance> = {
  readonly name: string
  readonly serviceTag: Tag

  readonly [ServiceVarianceTypeId]: ServiceVariance<Tag, Instance>

  readonly of: (this: void, implementation: Instance) => Instance
}
```

The function-property syntax makes the input position contravariant under `strictFunctionTypes`; the return remains covariant. Together they make `Instance` structurally invariant. The variance marker makes the intended relationship explicit and resilient to later changes in visible members.

TypeScript 5.2 rejects variance annotations on intersection aliases. Convert the existing public `ServiceToken` alias to an interface over a private constructor helper so its channels can be annotated without introducing a new public type name:

```ts
type AbstractServiceConstructor<out Instance> = abstract new (
  ...args: any[]
) => Instance

export interface ServiceToken<
  out Tag extends string = string,
  in out Instance = any
> extends AbstractServiceConstructor<Instance>,
    ServiceStatics<Tag, Instance> {}
```

`ServiceClass` remains its existing concrete-constructor intersection alias and receives the invariant contract through `ServiceStatics`. Changing `ServiceToken` from an alias to an interface preserves its public name, generic parameters, constructor-to-instance relationship, and resolver role, but intentionally strengthens assignability with the required hidden marker and makes the type declaration-mergeable. Rejection of manually constructed structural tokens and interface mergeability are accepted type-level compatibility trade-offs.

### Service factory

The class returned by `Service()` declares the matching static phantom field:

```ts
static declare readonly [ServiceVarianceTypeId]: ServiceVariance<Tag, Self>
```

A named private `Service()` return type that directly exposes the marker causes TS4020 when consumers emit declarations for exported subclasses. Avoid a new public heritage helper by typing the factory through the existing public `ServiceToken` interface:

```ts
interface ServiceFactory<Self> {
  <const Tag extends string>(
    tag: ServiceTagLiteral<Tag>
  ): (abstract new () => object) &
    Pick<
      ServiceToken<Tag, Self>,
      keyof ServiceToken<any, any>
    > & {
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

The `Pick` retains the static Service protocol while omitting the recursive construct signature. Using `keyof ServiceToken<any, any>` avoids dangling generic names in consumer declaration emit on TypeScript 5.2. The existing public `ServiceToken` name provides the declaration-visible indirection, so no new namespaced or top-level public helper is required.

The existing static `of` implementation remains a normal method:

```ts
static of(this: void, implementation: Self): Self {
  return implementation
}
```

Its type satisfies the function-property contract. The declaration-only field and type-only marker imports emit no JavaScript.

The marker is internal rather than exported from the package root. This intentionally requires public Service tokens to originate from `Service()`. Consumers can still use `Service.of` for structural implementation values.

The marker does not make Service instance contracts nominal. Tokens produced by `Service()` with the same tag and bidirectionally equivalent structural instance contracts remain compatible. The marker prevents omission of the Service protocol and unsafe widening of the instance channel; `any` remains an intentional erasure escape hatch.

### Preserved behavior

The following contracts remain unchanged:

- `yield* Database` infers exactly `Database`;
- `ServiceRuntime.resolve(Database)` infers exactly `Database`;
- `Database.of({...})` returns the original object typed as `Database`;
- `serviceTag` remains a readable literal string and the logical Service identity;
- resolver and backend APIs continue to use the Service class constructor as the token.

## Layer Contract

Introduce a structural marker that represents both Layer channels:

```ts
interface LayerVariance<in out Specs, out Collisions> {
  readonly _Specs: Invariant<Specs>
  readonly _Collisions: Covariant<Collisions>
}
```

Update the Layer declaration:

```ts
export class Layer<
  in out Specs extends AnyLayerSpec = AnyLayerSpec,
  out Collisions extends AnyServiceToken = never
> {
  declare readonly [LayerTypeId]: LayerVariance<Specs, Collisions>

  // runtime implementation unchanged
}
```

The existing collision marker may be removed or folded into the combined marker as an implementation detail, provided extraction helpers and generated declarations preserve the approved variance.

Invariant parameters have no single universal instantiation. In particular, `Layer<any, any>` does not accept `Layer<never, never>` on either TypeScript 5.2 or the current compiler. Redefine the erased Layer union as:

```ts
export type AnyLayer =
  | Layer<any, any>
  | Layer<never, any>
```

Every valid `Specs extends AnyLayerSpec` is either `never` or assignable through the `any` branch, so `Layer.Any` remains the universal public generic boundary. `Layer<any, any>` continues to erase ordinary non-`never` Layers but must no longer be documented as universal.

A bare `Layer` annotation continues to mean `Layer<AnyLayerSpec, never>`, but a concrete Layer is no longer assignable to it merely by widening its exact provider union. Consumers that intentionally erase arbitrary Layer metadata must use `Layer.Any`.

The `never` union arm must also be handled explicitly by inference helpers because matching an invariant `Layer<never, C>` against `Layer<any, infer C>` is not reliable:

```ts
export type LayerSpecs<L extends AnyLayer> =
  L extends Layer<never, any>
    ? never
    : L extends Layer<infer Specs, any>
      ? Specs
      : never

export type LayerCollisions<L extends AnyLayer> =
  L extends Layer<never, infer Collisions>
    ? Collisions
    : L extends Layer<any, infer Collisions>
      ? Collisions
      : never
```

Provider and requirement extraction must remain distributive over the extracted Specs. Route both public helpers through naked type-parameter helpers so `never` stays `never` rather than matching `LayerSpec<infer ...>` non-distributively:

```ts
type LayerSpecProvided<Specs extends AnyLayerSpec> =
  Specs extends LayerSpec<infer Provided, any>
    ? Provided
    : never

type LayerSpecRequired<Specs extends AnyLayerSpec> =
  Specs extends LayerSpec<any, infer Required>
    ? Required
    : never

export type LayerProvided<L extends AnyLayer> =
  LayerSpecProvided<LayerSpecs<L>>

export type LayerRawRequired<L extends AnyLayer> =
  LayerSpecRequired<LayerSpecs<L>>
```

An empty Layer therefore provides and requires `never`; collision extraction remains exact even when Specs is `never`.

The invariant comparison also requires small type-level construction adjustments without runtime changes:

- `Layer.gen` uses one localized cast from `Layer.make` because generator-yield requirements extend the method-derived requirements returned by `make`;
- `Layer.merge` and `Layer.override` constrain inputs with `AnyLayer` and use the corrected distributive `LayerSpecs` and `LayerCollisions` helpers;
- `Layer.override` keeps its existing localized type-erasure cast.

All provider arrays, loops, acquisition, release, merge, and replacement behavior remain unchanged.

## Covariant Metadata Types

Declare the already-structural covariance explicitly:

```ts
export type LayerSpec<
  out Provided extends AnyServiceToken,
  out Required extends AnyServiceToken = never
> = {
  readonly provided: Provided
  readonly required: Required
}
```

```ts
export interface ServiceRequirement<out T extends AnyServiceToken> {
  readonly [ServiceRequirementTypeId]: T
}
```

These annotations document the safe widening direction and protect against future members that would accidentally consume the parameters.

`EffectResult` remains unchanged. Its optional readonly requirements property already provides the desired covariance, and this change does not introduce an auxiliary variance wrapper without a demonstrated safety problem.

## Compatibility

This is a type-system hardening change with no intended runtime behavior change.

It intentionally rejects:

1. widening a `ServiceToken` or `ServiceClass` to a broader instance contract;
2. manually constructing a Service token that did not originate from `Service()`;
3. widening or narrowing the exact provider specification of a `Layer`;
4. using a bare `Layer` annotation as an implicit metadata-erasure boundary.

It preserves:

- the public `ServiceToken` name, generic shape, constructor-to-instance relationship, and resolver usage while changing its declaration kind from alias to mergeable interface;
- all documented Service declaration syntax;
- structural implementation objects passed through `Service.of`;
- Layer creation, merge, override, completeness, and Runtime inference APIs;
- package runtime exports and JavaScript output;
- the existing TypeScript peer lower bound of 5.2.0.

The README will state that Service tokens are created with `Service()` and that `Service.of` remains the supported mechanism for structural implementations.

`LayerSpec` remains available from the source-level Layer barrel but is not promoted to a new package-root export. Its explicit covariance is validated by source tests. Built-package tests validate Layer variance through the public `Layer` generic and structural specification shapes rather than importing `LayerSpec` from the package root.

## Testing Strategy

### Current-compiler source tests

Add focused type tests under `packages/better-effect/tests/types/` before implementation and observe their expected failures.

Service tests must prove:

- `ServiceClass<'Animal', DogService>` cannot widen to `ServiceClass<'Animal', AnimalService>`;
- the equivalent `ServiceToken` widening is rejected;
- a manually declared class with matching constructor, tag, and `of` members but without the hidden Service marker is rejected as both `ServiceToken` and `ServiceClass`;
- bidirectionally equivalent structural instance contracts produced by `Service()` remain compatible;
- a literal tag can widen conservatively while the instance contract remains identical;
- exact yield and resolver inference still hold;
- `Service.of` still accepts valid structural implementations and rejects invalid ones.

Layer tests must prove:

- `Layer<DatabaseSpec>` cannot widen to `Layer<DatabaseSpec | LoggerSpec>`;
- the reverse narrowing is also rejected;
- the provided Service union extracted from a Layer remains exact;
- collision metadata is covariant and cannot be narrowed away;
- assigning a concrete Layer to bare `Layer` is rejected;
- `Layer.Any` accepts ordinary and `never`-Specs Layers as the universal erased boundary;
- `Layer<any, any>` accepts ordinary non-`never` Layers but rejects `Layer<never, never>`;
- zero-argument `Layer.merge()` remains supported and has `LayerProvided`, `LayerRawRequired`, and `LayerCollisions` equal to `never`;
- `LayerCollisions<Layer<never, Collision>>` preserves `Collision` while provided and required metadata remain `never`;
- existing source and built-package namespace equality tests are updated to `Layer<any, any> | Layer<never, any>`.

Metadata tests must prove:

- `LayerSpec` is covariant in `Provided` and `Required`;
- `ServiceRequirement` is covariant;
- Effect requirements can still widen conservatively and cannot be narrowed unsafely.

### Built-package consumer fixture

Add a separate package consumer fixture for variance hardening. It imports only from the public `better-effect` entrypoint and compiles with:

- the current project compiler;
- TypeScript 5.2.2.

The fixture repeats representative positive and `@ts-expect-error` assignments. It explicitly covers manual token rejection, concrete-to-bare `Layer` rejection, ordinary erasure to `Layer<any, any>`, universal erasure to `Layer.Any`, and the `Layer<never, never>` edge that only `Layer.Any` accepts. It exports at least one `Service()` subclass and performs declaration-only emit, ensuring the hidden marker does not produce TS4020 or a dangling private name. Generated fixture declarations go to an ignored temporary `out` directory that each package script removes before and after a successful run.

The fixture validates the generated package declarations, not private source imports. Because `LayerSpec` is not a package-root export, it supplies equivalent structural specification shapes when instantiating the public `Layer` generic. The TypeScript 5.2 check uses an empty ambient `types` list so current Bun or Node declarations do not invalidate the minimum-compiler test independently of this package.

### Artifact checks

After `tsdown` builds the package, validate semantics primarily by compiling the built-package fixture with both supported compilers. Extend the existing declaration-graph traversal so textual checks inspect the root declaration and every referenced local declaration chunk rather than assuming declarations remain in `dist/index.d.mts` or retain a particular generated chunk name.

The artifact checker must establish that:

- the declaration graph contains explicit `in out` Layer Specs, `out` Layer collisions, and covariant metadata declarations;
- the public Service contract contains a required unique-symbol-keyed phantom member and exposes `of` as a function property;
- every generated `.mjs` file remains free of assignments or initialization for the phantom fields;
- runtime reflection on a Service class produced by `Service()` finds only its existing async-iterator symbol member, not an additional variance symbol;
- runtime reflection on a Layer instance finds no symbol-keyed variance property.

Compiler-based assignability checks are authoritative when declaration bundling renames internal declarations. Textual checks should match declaration shapes rather than generated internal type names, and runtime checks should inspect emitted values rather than searching for a specific private marker spelling.

Add the focused package check to the package `check` script and CI after build, alongside the existing public-type-namespace validation.

### Verification

During implementation, run focused typechecks after the red and green phases. Before completion, run:

```bash
bun run check
```

Also confirm the package dry run and generated declaration/ESM inspections. Any pre-existing lint baseline must be reported separately; no new diagnostic may be introduced by this change.

## Documentation

Update `packages/better-effect/README.md` with a concise contract note:

- Service tokens are declared through `Service<Self>()(tag)`;
- `Service.of` creates type-checked structural implementation values, not alternate tokens;
- Layer metadata represents its exact provider composition and should only be erased intentionally through `Layer.Any` at generic boundaries.

No example behavior or public runtime API changes are required.

## Acceptance Criteria

- Unsafe Service instance widening is rejected for both `ServiceToken` and `ServiceClass`.
- Unsafe Layer provider widening and narrowing are rejected.
- `Tag`, `LayerSpec`, `ServiceRequirement`, and Layer collision covariance behave as designed.
- Exact Service yield and resolver inference remain unchanged.
- Structural implementations through `Service.of` remain supported.
- Existing Layer inference, zero-argument merge, composition, override, completeness, and Runtime execution checks pass.
- Exported consumer subclasses of `Service()` emit portable declarations without TS4020 on TypeScript 5.2.2 and the current compiler.
- `Layer.Any` accepts `Layer<never, never>` while `Layer<any, any>` is not described as universal.
- TypeScript 5.2.2 and the current compiler consume the built package fixture successfully.
- Generated declarations expose the intended variance contract.
- Generated JavaScript contains no phantom marker implementation or new runtime properties.
- README guidance reflects the token and Layer metadata contracts.
- `bun run check` is executed and all feature-relevant checks pass.

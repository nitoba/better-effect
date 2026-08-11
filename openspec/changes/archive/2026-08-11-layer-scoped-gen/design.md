## Context

`Layer.gen` already uses `LayerGenerator` and `runLayerGenerator` to preserve yielded Service requirements while constructing a provider. `Layer.scoped` stores a release callback on the erased `LayerProvider`, and `buildLayer` binds that provider to the Runtime root Scope before backend registration. The root Scope is outcome-aware, but the current internal provider release contract discards its outcome.

The implementation must preserve lazy backend resolution, root-Scope ownership, typed Layer completeness, and the rule that DI backends never own Service release semantics.

## Goals / Non-Goals

**Goals:**

- Compose the existing generator acquisition path with the existing root-scoped provider path.
- Preserve exact Service and dependency inference at the public constructor boundary.
- Deliver the root `ScopeOutcome` to `Layer.scopedGen` cleanup.
- Keep type erasure localized to the internal `LayerProvider` representation.

**Non-Goals:**

- Changing the signatures or behavior of `Layer.gen` and `Layer.scoped`.
- Adding generator-based release callbacks, outcome-aware `Layer.scoped`, transactions, cancellation, or new Scope strategies.
- Moving provider caching, dependency graphs, or release ownership into a DI backend.
- Changing Runtime shutdown precedence or cleanup diagnostics.

## Decisions

### Add a distinct `Layer.scopedGen` constructor

The API will be:

```ts
Layer.scopedGen(
  Service,
  async function* () {
    const dependency = yield* Dependency

    return new Service(dependency)
  },
  (service, outcome) => service.close(outcome)
)
```

A distinct name makes acquisition dependencies and scoped ownership explicit without overloading `Layer.scoped` based on whether its callback returns an async generator. It also avoids making `release` an optional semantic switch on `Layer.gen`.

Alternatives considered:

- An overload on `Layer.scoped`: rejected because runtime and type-level discrimination between ordinary acquisition and generator acquisition would obscure a small API.
- An optional third argument on `Layer.gen`: rejected because resource ownership should be visible in the constructor name.

### Reuse the existing generator requirement model

`Layer.scopedGen` will use the existing `LayerGenerator<S, Yield>` factory type and return `Layer<LayerSpec<S, LayerGeneratorRequirements<S, Yield>>>`. No second inference system or new Layer generic is needed.

The release callback is typed at the public boundary with `InstanceType<S>` and `ScopeOutcome`. The erased provider callback may use `unknown` internally, with the cast kept inside `Layer.scopedGen` just as it is in `Layer.scoped`.

### Make the internal provider release path outcome-aware

The internal `LayerProvider.release` contract will accept the erased instance plus `ScopeOutcome`. `bindProviderToScope` will forward the outcome supplied by `rootScope.acquire`.

`Layer.scopedGen` forwards both arguments to its public release callback. Existing `Layer.scoped` wraps its one-argument release callback and intentionally ignores the additional internal outcome, preserving its public API and behavior.

This shared internal path ensures root closure, one-shot Runtime outcome propagation, cleanup aggregation, and observer behavior remain centralized in Scope and Runtime.

### Register cleanup only after the generator returns an instance

The bound provider continues to call `rootScope.acquire(provider.acquire, provider.release)`. Consequently, a failed or rejected generator factory registers no finalizer. If the root begins closing while acquisition is pending, existing `Scope.acquire` behavior immediately releases the acquired instance with the chosen outcome or aggregates acquisition/cleanup races according to Scope rules.

### Rely on acquisition order for dependency-safe cleanup

If provider A yields provider B, B finishes acquisition and registers its root finalizer before A can finish and register its own. Root LIFO cleanup therefore releases A before B without a Layer-owned dependency graph.

## Risks / Trade-offs

- [The new name increases the Layer surface by one method] → Keep it as the only explicit composition of generator dependencies and root-scoped cleanup; do not add aliases or overloads.
- [An adapter that acquires providers eagerly could violate lazy/root ordering assumptions] → Preserve and test the `LayerBackend.register` contract that registration does not acquire providers; adapters remain responsible for resolution and caching only.
- [Passing outcomes internally could accidentally expand `Layer.scoped` publicly] → Add compile-time tests that preserve its existing one-argument release signature while validating the two-argument `Layer.scopedGen` callback.
- [Circular provider dependencies remain possible at runtime] → Leave cycle handling to the backend, as with `Layer.gen`; this change does not introduce a core dependency graph.

## Migration Plan

This is additive and requires no consumer migration. Existing `Layer.gen` and `Layer.scoped` declarations continue to compile unchanged. Consumers that currently work around the gap can move to `Layer.scopedGen` incrementally. Rollback consists of removing the new constructor and restoring the internal one-argument provider release adapter; no persisted data or wire format is involved.

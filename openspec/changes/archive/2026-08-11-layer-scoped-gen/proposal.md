## Why

`Layer.gen` can construct a Service from contextual dependencies but cannot register its cleanup, while `Layer.scoped` can register cleanup but cannot express contextual dependencies. Applications therefore have no direct, type-safe Layer API for a resource-owning provider whose acquisition depends on other Services.

## What Changes

- Add `Layer.scopedGen(Service, factory, release)` as the explicit combination of generator-based dependency access and root-scoped cleanup.
- Infer the provider's required Service-token union from the generator while preserving the provided Service token.
- Run the generator factory in the Runtime root Scope and register the release callback only after successful acquisition.
- Pass the root Scope outcome to the release callback, matching existing outcome-aware Scope acquisition semantics.
- Keep `Layer.gen`, `Layer.scoped`, `Resource`, Runtime disposal, and DI backend ownership semantics unchanged.

## Capabilities

### New Capabilities

- `layer-scoped-providers`: Defines generator-based Layer acquisition with root-Scope ownership and outcome-aware cleanup.

### Modified Capabilities

- `typed-layer-requirements`: Extends Layer requirement inference and completeness validation to `Layer.scopedGen` providers.

## Impact

- Public API: adds `Layer.scopedGen` and its generator/release type contract.
- Core implementation: `src/layer/` provider construction and type inference.
- Lifecycle: reuses the existing Runtime root Scope; DI backends remain responsible only for resolution and caching.
- Tests and docs: runtime cleanup/order tests, compile-time requirement tests, README, and project invariants.
- Dependencies: no new runtime dependencies.

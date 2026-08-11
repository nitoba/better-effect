## 1. Effect requirement propagation

- [x] 1.1 Make `EffectRequirements<T>` distributive and presence-aware so unbranded `better-result` Results resolve to `never` while Promise-wrapped branded results preserve their metadata.
- [x] 1.2 Extend the Effect generator result type to union requirements inferred from yielded Services with requirements carried by its returned EffectResult.
- [x] 1.3 Add compile-time tests for direct requirements, returned nested EffectResults, ordinary Results, Promise-wrapped metadata, and the existing `Scope` exclusion.

## 2. Layer missing-service diagnostics

- [x] 2.1 Replace the opaque completeness phantom with a named type-only missing-Service constraint while keeping `LayerMissing<L>` as the raw token union.
- [x] 2.2 Add or update type tests proving incomplete Layers expose the named missing set and complete Layers remain accepted with `LayerMissing<L> = never`.

## 3. Layer override inference

- [x] 3.1 Add type-level helpers that remove current specs for a replacement's provided token and append the replacement spec.
- [x] 3.2 Process the const tuple of overrides left-to-right so repeated replacements match runtime last-write-wins behavior.
- [x] 3.3 Update `Layer.override`'s return type without changing its runtime provider Map implementation.
- [x] 3.4 Add type tests proving obsolete acquisition requirements disappear, replacement requirements remain, unrelated specs are preserved, and multiple overrides use the final provider specification.

## 4. Compatibility and verification

- [x] 4.1 Confirm the public API does not introduce `Effect.await`, `Effect<A, E, R>`, or `Layer<ROut, E, RIn>` and that runtime sources are unchanged except for type annotations.
- [x] 4.2 Run `bun run check` and resolve any type, test, lint, format, build, or package validation regressions.

## Context

The existing type model stores Layer specifications as a union of `{ provided, required }` records and carries Effect requirements through an optional phantom property. `Effect.gen` currently reads requirements only from yielded Service markers. `Layer.override` currently unions base and override specs even though runtime provider selection is last-write-wins. The change must remain type-only: runtime Result execution, provider registration, and public generic shapes stay unchanged.

## Goals / Non-Goals

**Goals:**

- Preserve requirement metadata when an Effect generator returns another branded Effect result.
- Make metadata extraction distributive and distinguish branded results from ordinary Results.
- Keep `LayerMissing<L>` as a useful union of Service tokens while improving the completeness constraint shown by TypeScript diagnostics.
- Model `Layer.override` as sequential replacement of provider specifications, including multiple overrides.
- Keep all changes localized to type aliases, overload result types, and compile-time tests.

**Non-Goals:**

- Do not add `Effect.await`; requirements passed through the existing `better-result` `Result.await` signature remain outside this change.
- Do not introduce `Effect<A, E, R>`, `Layer<ROut, E, RIn>`, Context, or a typed dependency graph.
- Do not change runtime behavior, Layer provider registration, Service resolution, or Result error precedence.
- Do not introduce nominal Service-token branding as part of this refinement.

## Decisions

### Preserve requirements from returned Effect results

Extend the result type produced by an Effect generator with the union of requirements from its yielded values and its returned Result. This uses the metadata channel already present in the public `EffectResult` type and requires no runtime wrapper.

An alternative would be to inspect generator bodies or recursively inspect arbitrary method implementations. TypeScript cannot perform either operation, so the returned-result channel is the reliable boundary for this change.

### Make metadata extraction distributive and presence-aware

The extractor will distribute over unions and check whether the phantom metadata key exists before inferring its value. Checking key presence avoids interpreting the optional metadata property on an ordinary Result as `unknown`.

### Use a named phantom completeness constraint

`LayerMissing<L>` remains the raw Service-token union for exact type assertions and set operations. The complete-Layer constraint will use a named, type-only property whose value is that union, so compiler diagnostics identify the missing-Service payload without adding a runtime field or changing Layer's generic shape.

### Apply overrides left-to-right

Override inference will process the const tuple of override Layers recursively. For each override, it removes current specs whose provided token matches the replacement and then adds the replacement specs. This mirrors the existing runtime Map behavior and handles repeated overrides correctly.

The type-level token comparison will use the same structural assignability assumptions already used by Layer requirement analysis. True nominal identity for structurally identical Service classes is intentionally deferred.

### Keep composition through `Result.await` out of scope

The current `better-result` `Result.await` declaration returns a generator whose yield type contains only its Result error. It does not expose metadata from an `EffectResult` argument. Recovering those requirements would require a new typed adapter or dependency declaration change, so this design deliberately limits propagation to the returned EffectResult channel.

## Risks / Trade-offs

- **[Risk]** The named phantom property is visible in public type diagnostics and could be manually satisfied with a cast. **Mitigation:** it remains type-only and is used only as a compile-time completeness guard; normal consumers still use `LayerMissing<L>` for inspection.
- **[Risk]** Structural comparison can treat two empty Service classes as equivalent. **Mitigation:** preserve existing comparison semantics and defer nominal token branding to a separate change with dedicated compatibility analysis.
- **[Risk]** Requirements from `yield* Result.await(effectResult)` remain untracked. **Mitigation:** document this boundary and cover only supported returned-result propagation in this change's type tests.

## Migration Plan

No runtime migration is required. Existing Layer, Effect, and Runtime calls keep their signatures. Update compile-time expectations for the more precise override and metadata behavior, then run the standard typecheck, tests, lint, format, build, and package validation commands.

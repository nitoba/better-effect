## Why

The current typed Layer model detects missing Services, but compiler diagnostics expose an opaque phantom constraint and `Layer.override` retains requirements from providers that were replaced. `Effect.gen` also drops requirements carried by a composed `EffectResult`, which makes the type-level dependency model incomplete as programs are composed.

This refinement improves the usefulness and correctness of the existing type-level metadata without expanding the public API into `Effect<A, E, R>` or `Layer<ROut, E, R>`, and without introducing `Effect.await` in this change.

## What Changes

- Make the compile-time missing-Layer constraint expose a named, readable phantom property while preserving `LayerMissing<L>` as the machine-readable union of Service tokens.
- Make `Effect.gen` include requirements carried by its returned `EffectResult` in addition to requirements inferred from yielded Services.
- Make phantom requirement extraction distributive and presence-aware so ordinary `better-result` Results do not produce spurious `unknown` requirements.
- Refine `Layer.override` to remove specs for replaced provider tokens and apply multiple overrides in runtime order (last override wins).
- Add runtime-neutral type tests covering nested EffectResult propagation, readable missing requirements, and replacement semantics.
- Do not add `Effect.await`, `Effect<A, E, R>`, or `Layer<ROut, E, R>` to the public API.

## Capabilities

### New Capabilities

- `typed-layer-requirements`: Type-level propagation, diagnostics, and replacement rules for Effect and Layer requirements.

### Modified Capabilities

None.

## Impact

- Affected types: `EffectRequirements`, `EffectFromGenerator`, `CompleteLayer`, `Layer.override`, and related Layer inference helpers.
- Affected tests: compile-time tests under `tests/types/` and focused Layer/Effect type contracts.
- Runtime behavior and provider registration remain unchanged.
- No new dependencies and no changes to the public Result error or success channels.

## 1. Shared Service Requirement Inference

- [x] 1.1 Extract the existing required-versus-provided Service-token comparison into one internal reusable type without changing `LayerMissing` or `CompleteLayer` results.
- [x] 1.2 Add execution inference helpers that derive missing Services from a program's final `EffectRequirements` and produce the `__betterEffectMissingRuntimeServices` diagnostic marker.
- [x] 1.3 Preserve the existing Layer inference and override type tests while adding focused assertions for the shared missing-Service comparison.

## 2. Typed Runtime Handles

- [x] 2.1 Parameterize `BuiltLayer` by its provided Service union with the source-compatible erased default, and make `buildLayer()` return `BuiltLayer<LayerProvided<L>>`.
- [x] 2.2 Parameterize `Runtime` by its provided Service union with the same erased default, store the correspondingly typed BuiltLayer, and make `Runtime.make()` return `Runtime<LayerProvided<L>>`.
- [x] 2.3 Constrain `BuiltLayer.run()` and managed `Runtime.run()` callbacks against their provided Service unions while preserving the original awaited return type.
- [x] 2.4 Constrain static one-shot `Runtime.run()` against `LayerProvided<L>` without reclassifying or eagerly starting the user program.
- [x] 2.5 Keep the execution-validation helpers type-only and confirm that Scope, graceful shutdown, outcome classification, and backend behavior are unchanged.

## 3. Compile-Time Contract Tests

- [x] 3.1 Add exact type assertions for Runtime and BuiltLayer environments inferred from merged and overridden Layers.
- [x] 3.2 Add accepted-call tests for managed Runtime, BuiltLayer, and one-shot executions whose Effect requirements are fully provided.
- [x] 3.3 Add `@ts-expect-error` tests for one and multiple missing Services across all public execution boundaries, with the exact missing-token union represented by the diagnostic contract.
- [x] 3.4 Add composed-Effect tests proving that direct and returned requirements are validated together.
- [x] 3.5 Add compatibility tests for plain values, ordinary Results, Scope-only Effects, `Effect.acquireRelease`, and unparameterized Runtime and BuiltLayer annotations.
- [x] 3.6 Assert that accepted executions preserve their exact success, error, requirements, Promise, and awaited result types.

## 4. Documentation and Example

- [x] 4.1 Update README Runtime guidance to show inferred provided Services, compile-time rejection of unavailable Services, and the intentionally erased unparameterized annotation.
- [x] 4.2 Update the TODO example so helper boundaries retain the App Runtime's inferred environment instead of silently erasing it.
- [x] 4.3 Update `AGENTS.md` with the invariant that every typed execution boundary validates final Effect requirements against its Runtime environment.

## 5. Verification

- [x] 5.1 Run the focused typecheck and Runtime/Layer test suites and address inference or compatibility regressions.
- [x] 5.2 Run `bun run check`.
- [x] 5.3 Run `bun pm pack --dry-run` and inspect the generated public declarations for precise Runtime and BuiltLayer generics.

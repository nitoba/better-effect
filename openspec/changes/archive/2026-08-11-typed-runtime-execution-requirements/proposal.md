## Why

`Effect.gen` already records required Service tokens and Layers already record the Services they provide, but that relationship is erased when a `Runtime` or `BuiltLayer` is created. As a result, a program can request a Service absent from its Runtime, compile successfully, and fail only during resolution.

## What Changes

- Make `Runtime` carry the Service-token union provided by the Layer used to construct it.
- Make `BuiltLayer` preserve the same provided-Service information for callers that use `buildLayer()` directly.
- **BREAKING (type-level)** Validate the requirements of programs passed to instance `run()` and static `Runtime.run()` against the Services provided by their Layer; previously compiling executions with genuinely missing Services will become compile-time errors.
- Preserve support for programs with no Effect requirements, including plain values and ordinary `better-result` Results.
- Add a named missing-Service type contract so compile-time diagnostics identify the exact unavailable Service tokens.
- Preserve source compatibility for code that uses the unparameterized `Runtime` or `BuiltLayer` types as intentionally erased/unchecked annotations.
- Add type-contract tests and update documentation and the TODO example to retain inferred Runtime environment types.

## Capabilities

### New Capabilities

- `typed-runtime-execution-requirements`: Compile-time validation that an Effect program's Service requirements are provided by the Runtime or BuiltLayer executing it.

### Modified Capabilities

None.

## Impact

- Public TypeScript signatures for `Runtime`, `BuiltLayer`, `Runtime.make()`, `Runtime.run()`, and `buildLayer()`.
- Layer inference helpers used to compare required and provided Service tokens.
- Compile-time tests under `tests/types/` and Runtime usage in the TODO example and README.
- No runtime behavior, DI backend protocol, lifecycle semantics, or dependencies change.

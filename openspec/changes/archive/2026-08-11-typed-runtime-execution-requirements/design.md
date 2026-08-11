## Context

See `proposal.md` for motivation. `EffectResult` already carries a phantom `EffectRequirements` union, and `Layer` already carries `LayerProvided` plus the token-compatibility logic used by `CompleteLayer`. The missing link is that `Runtime`, `BuiltLayer`, and their `run()` methods currently erase the provided environment.

This is a compile-time feature. Runtime execution, Scope ownership, outcome classification, graceful disposal, and backend resolution must remain byte-for-byte equivalent in behavior. The callback form of `run()` must also remain lazy so Service and Scope contexts are installed before an Effect begins.

## Goals / Non-Goals

**Goals:**

- Preserve the exact provided-Service union from Layer construction through Runtime and BuiltLayer handles.
- Reject execution callbacks whose final Effect requirements are not satisfied by that union.
- Reuse one Service-token compatibility relation for Layer completeness and Runtime execution.
- Preserve exact result inference and source compatibility for explicitly environment-erased Runtime annotations.
- Produce readable TypeScript diagnostics and protect them with compile-time tests.

**Non-Goals:**

- Add runtime dependency checks, eager provider resolution, or another DI graph.
- Track dependencies obtained through the low-level `ServiceRuntime.resolve()` escape hatch.
- Change `Effect.gen`, Service resolution, Layer composition, Scope lifecycle, cleanup precedence, or Runtime shutdown.
- Add a new Runtime implementation, eager Effect values, or a `Runtime.gen` convenience API.
- Remove or deprecate `buildLayer`, `BuiltLayer`, or unparameterized Runtime annotations.

## Decisions

### 1. Runtime and BuiltLayer carry a provided-Service generic

Use the public shapes:

```ts
Runtime<
  Provided extends AnyServiceToken =
    AnyServiceToken
>

BuiltLayer<
  Provided extends AnyServiceToken =
    AnyServiceToken
>
```

`Runtime.make(layer, ...)` returns `Runtime<LayerProvided<L>>`, while `buildLayer(layer, ...)` returns `BuiltLayer<LayerProvided<L>>`. The Runtime stores a correspondingly typed BuiltLayer, but the generic remains phantom and introduces no runtime state.

The default `AnyServiceToken` represents an intentionally erased environment. This preserves code such as `runtime: Runtime` and `built: BuiltLayer`, including the current TODO example. Removing the default or using `never` would make existing annotations unexpectedly reject every Service-requiring program.

Alternative considered: introduce a separate `TypedRuntime`. Rejected because it would duplicate the existing Runtime lifecycle and let the primary API remain unsound.

### 2. Share Service requirement satisfaction with Layer completeness

Extract the existing distributive comparison between required and provided Service tokens into one internal reusable type. Both `LayerMissing` and Runtime execution validation use this relation, preserving the current constructor/instance compatibility semantics instead of inventing a second definition of “provided”.

Define execution-oriented helpers conceptually as:

```ts
type ExecutionMissing<Provided, ProgramResult> = MissingServices<
  EffectRequirements<ProgramResult>,
  Provided
>

type MissingRuntimeServices<Missing> = {
  readonly __betterEffectMissingRuntimeServices: Missing
}
```

When `ExecutionMissing` is `never`, the callback remains unchanged. Otherwise, the callback parameter is intersected with `MissingRuntimeServices<ExecutionMissing<...>>`. This follows the established `CompleteLayer` diagnostic pattern and makes the exact missing-token union visible in compiler errors.

These helpers may remain internal unless an exported helper is required to produce stable declarations. The named marker is the public diagnostic contract required by the spec.

Alternative considered: use `Exclude<Required, Provided>`. Rejected because Service tokens are constructor types and Layer completeness already has explicit compatibility semantics that must remain authoritative.

### 3. Validate the lazy callback while preserving return inference

The public `run()` signatures infer the callback return as they do today and apply the conditional missing-Service constraint to that callback:

```ts
run<A>(
  program:
    CompleteExecution<
      Provided,
      A
    >
): Promise<Awaited<A>>
```

`CompleteExecution` retains `() => A | PromiseLike<A>` as the inference source and adds only the diagnostic intersection when requirements are missing. The implementation may use a private unchecked method or an implementation signature broader than the public overload so internal wrappers, particularly the one-shot outcome-capturing callback, are not revalidated through a widened generic.

The API continues to accept callbacks rather than already-started Effect values. Accepting eager values would run Service or Scope access before Runtime context installation.

Alternative considered: validate the resolved value at runtime. Rejected because requirement metadata is phantom and the backend already owns actual missing-Service errors.

### 4. Apply the contract to every public execution boundary

The same validation applies to:

- `Runtime<Provided>.run()`;
- `BuiltLayer<Provided>.run()`;
- static `Runtime.run(layer, backend, program)`, using `LayerProvided<L>` directly.

Leaving BuiltLayer unchecked would preserve a public route around the contract. Static Runtime validation must occur on the user callback parameter, not on the internal callback used to capture the one-shot program outcome.

### 5. Only branded Effect requirements participate

Validation reads `EffectRequirements<Awaited<A>>`. Plain values, ordinary Results, Scope-only Effects, and `Effect.acquireRelease` programs without Services therefore produce `never` and remain accepted everywhere. Direct calls to `ServiceRuntime.resolve()` also remain untracked by design because they carry no Effect requirement metadata.

Composed Effect requirements already flow through `EffectFromGenerator`; the Runtime consumes the final metadata rather than inspecting intermediate generator operations.

### 6. Type tests are the acceptance boundary

Add compile-time assertions for:

- exact Runtime and BuiltLayer environment inference;
- complete instance and one-shot executions;
- one and multiple missing Services with `@ts-expect-error`;
- composed Effect requirements;
- plain values, ordinary Results, Scope-only Effects, and `Effect.acquireRelease`;
- unparameterized Runtime and BuiltLayer annotations;
- `Layer.override()` environments;
- unchanged success, error, and awaited return types.

Runtime tests need only guard that the type-only refactor causes no behavioral regression; no new runtime branch is expected.

## Risks / Trade-offs

- **[Conditional types can interfere with callback inference]** → Keep the callback function as the primary inference position, isolate the conditional in a reusable intersection, and assert exact return types under TypeScript 7.
- **[Runtime generic variance can break `runtime: Runtime` annotations]** → Use a covariant phantom environment and an `AnyServiceToken` default, with explicit assignability tests for inferred handles passed through erased annotations.
- **[Compiler diagnostics may become unreadable for unions]** → Use the stable `__betterEffectMissingRuntimeServices` marker and test the exact missing union separately from negative call-site tests.
- **[The erased default is an escape hatch]** → Document that `Runtime` without a generic intentionally opts out; constructors still infer the precise environment by default.
- **[Stricter types reject code that previously compiled]** → Limit rejection to programs that would request genuinely unavailable Services and document the temporary erased annotation escape hatch.
- **[Shared token comparison refactor could change Layer inference]** → Preserve existing `LayerMissing` tests unchanged and add equivalence tests before applying the helper to Runtime.

## Migration Plan

1. Extract and test the shared missing-Service comparison without changing public Layer results.
2. Add provided-Service generics to BuiltLayer and Runtime with compatibility defaults.
3. Return precise handle types from `buildLayer()` and `Runtime.make()`.
4. Apply execution constraints to BuiltLayer instance, Runtime instance, and one-shot Runtime APIs.
5. Update the TODO example to retain its inferred App Runtime type rather than accidentally erasing it at function boundaries.
6. Update README guidance and public type exports as required.

Rollback is type-only: revert the generic execution constraints and handle generics. No persisted data, runtime state, or migration artifact is involved.

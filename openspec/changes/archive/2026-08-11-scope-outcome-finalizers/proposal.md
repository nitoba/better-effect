## Why

Scope cleanup currently knows only whether finalizers succeeded. That makes
transaction-like cleanup impossible to express and causes a program failure
plus cleanup failure to be returned as a new aggregate error, obscuring the
original program result. The lifecycle now has a complete execution boundary,
so it can classify one final outcome and give cleanup the context it needs
without adding Exit, Cause, Fiber, or cancellation machinery.

## What Changes

- Add a small `ScopeOutcome` union with `success` and `failure` states; the
  generic Scope remains independent of `better-result`.
- Separate the non-owning `Scope` capability from `CloseableScope`. Current
  execution context exposes only `Scope`; only an owner-created Scope or child
  can be closed. **BREAKING**: `Scope.current()` no longer exposes `close()`.
- Allow `CloseableScope.close(outcome?)`. Closing without an argument means
  success, the first close call fixes the outcome, and a parent propagates its
  chosen outcome to still-attached children.
- Pass the final outcome to `ScopeFinalizer` callbacks and to resource release
  callbacks while keeping existing no-argument/one-argument callbacks valid.
- Classify outcomes only at execution boundaries: plain values and `Result.ok`
  are success, `Result.err` is failure with its error, and thrown/rejected
  programs are failure with the thrown cause. Intermediate Results do not alter
  Scope state.
- Define the precedence `program failure > cleanup failure > program success`.
  Preserve the exact program exception or `Result.err`; when cleanup is the only
  failure, expose the aggregated `ScopeCloseError` as the external failure.
  **BREAKING**: program-plus-cleanup failures no longer escape as an
  `AggregateError` that replaces the original program failure.
- Keep `Scope.close()` itself observer-free. Boundary helpers and Runtime
  disposal may invoke one optional observer per close boundary with a single
  flattened `ScopeCloseError`; observer failures are best-effort diagnostics.
- Define one-shot Runtime shutdown precedence across execution Scope, root
  Scope, and backend cleanup. A failed program remains primary; successful
  programs expose root/backend cleanup failures.
- Expose optional cleanup diagnostics through `buildLayer` and `Runtime.make`,
  including the static `Runtime.run` boundary. Long-lived Runtime disposal
  closes the root with success; a build-failure cleanup closes it with failure.
- Add tests for outcome classification, precedence, CloseableScope ownership,
  propagation, idempotent close races, aggregated root/backend failures,
  transaction-style release callbacks, and recovery from an intermediate
  `Result.err` to a final `Result.ok`.
- Document the outcome contract and explicitly keep Exit/Cause, cancellation,
  Fiber, Resource refactoring, and a transaction abstraction out of scope.

## Capabilities

### New Capabilities

None. The change extends the existing Scope/Runtime and Effect lifecycle
contracts rather than introducing a separate public capability.

### Modified Capabilities

- `scope-hierarchy-runtime-shutdown`: add outcome-aware Scope closure and
  finalizers, CloseableScope ownership, execution-boundary classification,
  cleanup precedence/diagnostics, outcome propagation, and root shutdown
  semantics.
- `effect-acquire-release`: require release callbacks to receive the final
  `ScopeOutcome` while preserving the existing scoped acquisition API and typed
  Effect requirements.

## Impact

- Affected implementation: `src/scope/types.ts`, `src/scope/scope.ts`,
  `src/scope/internal.ts`, `src/scope/index.ts`, a new runtime outcome
  classifier/diagnostic module, `src/layer/runtime.ts`, `src/runtime/runtime.ts`,
  and the Effect acquire/release bridge.
- Affected public types: `Scope`, `CloseableScope`, `ScopeOutcome`, cleanup
  diagnostic/observer options, `Scope.close`, `ScopeFinalizer`, and
  acquire/release callback signatures.
- Affected tests, type tests, README, AGENTS.md, and CODEX_HANDOFF.md.
- No new runtime dependency; Scope must not import `better-result`.

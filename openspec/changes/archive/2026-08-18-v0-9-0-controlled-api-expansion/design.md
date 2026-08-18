## Context

The existing Effect layer is a thin type facade over `better-result`: runtime
values are ordinary Results, while Service requirements and lazy Programs are
declaration-only metadata. Current combinators already use small adapters in
`src/effect/combinators.ts`; Runtime resolution wraps a backend at the
resolution boundary; `CurrentAbortSignal` already reads the execution-local
Runtime context. See `proposal.md` and the delta specs for the required public
behavior.

## Goals / Non-Goals

**Goals:**

- Add the requested Effect operations without introducing an instruction tree,
  scheduler, Fiber abstraction, or a second Result implementation.
- Keep every returned Effect/Program's success, error, and Service requirement
  channels inferable through TypeScript 5.7.2 and the current compiler.
- Make Program collection lazy, bounded, and compatible with existing Scope and
  Runtime ownership.
- Keep infrastructure diagnostics and optional standard services container-
  agnostic and independently replaceable.

**Non-Goals:**

- A third `Layer` build-error channel, lazy Layer failure Results, cancellation
  of sibling Programs, or a general concurrency runtime.
- Implicit global standard-service instances or product-specific Config, Cache,
  HTTP, and database packages.

## Decisions

### 1. Adapt `better-result` directly

Implement the new Effect operations as thin wrappers around the corresponding
Result operations wherever they exist (`tap*`, recovery, matching, collection,
and flattening). Add only the small transformations that Result does not expose
(`as`, `asVoid`, and `zip`). This keeps short-circuiting, Promise behavior, and
exception normalization in one dependency.

The wrappers use the existing data-first/data-last convention and restore the
declaration-only Effect marker at the internal type-erasure boundary. No runtime
metadata is attached to a Result.

### 2. Union requirement metadata at each public boundary

Add generic helpers alongside the existing `EffectSuccess`, `EffectError`, and
`EffectRequirements` extractors. A unary transform carries `R` unchanged; a
continuation, nested flatten, match handler returning an Effect, collection, or
Program scheduler unions every statically possible Effect requirement. Keep
casts localized to the same adapters already used by `map` and `andThen`.

The compile-time fixtures will cover exact equality for `R`, error unions,
heterogeneous tuples, unselected match branches, and missing Runtime Services.

### 3. Keep Program collection lazy with a small FIFO worker pool

Expose `Program.all` as a value-level namespace operation over the existing
callable Program type. It returns a callable Program whose body creates no work
until invoked. At invocation, a FIFO worker pool starts at most `concurrency`
Programs, stores each settled result by input index, and returns the ordered
collection through the existing Result semantics. Omitted concurrency starts all
inputs. A positive integer is validated at construction; no cancellation or
scope replacement is added.

This is deliberately smaller than a scheduler: already-started callbacks finish
normally, and the enclosing Runtime execution owns their Scope and cleanup.

### 4. Wrap only at the Service resolution boundary

Keep `ServiceRuntime` as the resolver bridge. `createResolutionResolver` remains
the single place that detects path cycles, translates missing providers, and
wraps unexpected provider failures as `ServiceAcquisitionError`. Preserve
existing rich infrastructure errors and their causes. Adapters continue to own
container key translation; core diagnostics mention only Service tags/tokens.

### 5. Ship standard services as a separate entrypoint

Place standard Services and their test layers behind an optional
`better-effect/standard-services` package subpath. The entrypoint reuses core
`Service`, `Layer`, and Runtime context primitives and is added to the bundler
entry list without changing the root barrel's implicit environment. The existing
`CurrentAbortSignal` value remains behaviorally compatible and may be re-exported
from the optional entrypoint rather than implemented twice.

Each service task chooses the smallest useful contract and matching test layer:
Clock uses controlled time, Random uses a reproducible seed, Logger captures
structured events, and CurrentRequest carries execution-local request data.

### 6. Merge by independent PR-sized slices

Each task in `tasks.md` is a self-contained PR boundary: implementation, runtime
tests, type tests, docs/example updates, and `bun run check`. Later slices may
consume earlier public helpers but must not land speculative cross-cutting
abstractions. The final integration slice changes the package version to 0.9.0
only after all feature PRs are merged.

## Risks / Trade-offs

- **Type-level tuple inference may regress on TypeScript 5.7.2** → keep separate
  minimum-version declaration fixtures for each collection helper and avoid
  variadic abstractions beyond what the existing Result types require.
- **Concurrent Program failure leaves already-started work running** → document
  the no-cancellation rule and rely on the enclosing Scope/Runtime cleanup
  boundary; do not add forced shutdown machinery.
- **Optional service contracts can become a grab bag** → keep the subpath
  optional, require a test implementation for each service, and reject
  product-specific services from this package.
- **New subpath can be omitted from published declarations** → add it to the
  tsdown entry list, package exports, publint checks, and package-type fixtures
  in the same PR as the first standard service.

## Migration Plan

The change is additive. Existing `map`, `mapError`, `andThen`,
`andThenAsync`, `CurrentAbortSignal`, Service errors, and two-channel Layer
types remain source-compatible. Land feature PRs in task order, run the full
check suite at each boundary, then update the package version and release
metadata in the final PR. If a slice must be rolled back, revert that PR; no
data migration or runtime state migration is required.

## Context

See `proposal.md` for the motivation and externally visible scope. The current
implementation derives requirement compatibility from structural constructor and
instance assignability, while runtime backends key registrations by constructor
objects. The repository already carries phantom requirement metadata through
`better-result`; the design must change only the Service identity carried by
that metadata and by Layer/backend registration.

## Goals / Non-Goals

**Goals:**

- Make a literal `Service<Self>()('Name')` tag available on the returned class
  and preserve the concrete subclass constructor through `yield*`.
- Make the same tag/contract comparison drive Effect requirements, Layer
  completeness, overrides, and Runtime execution validation.
- Make the built-in backend maps use tags while retaining constructor handles
  for type relationships, diagnostics, and collision context.
- Preserve structural implementations, better-result semantics, and all Scope,
  Resource, and Runtime lifecycle behavior.

**Non-Goals:**

- A full Effect Context or typed dependency graph.
- User-authored brands, decorators, transformers, code generation, or a new
  runtime scheduler.
- Runtime reflection that attempts to reconstruct arbitrary erased TypeScript
  method signatures.
- A permanent compatibility overload for the old untagged `Service<Self>()`
  syntax.

## Decisions

### 1. Use a literal static tag and a self-capturing static iterator

`Service<Self>()(tag)` returns a base class with a readonly `serviceTag: Tag`
and a static async iterator returning `Self` and carrying the tag-aware Service
requirement contract. The explicit self type is necessary to preserve exact
`yield*` inference: TypeScript does not specialize an inherited generic static
iterator from the derived constructor at the async iterator protocol boundary.
The curried tag call keeps `Tag` inferred as a literal without repeating it in
the type argument list. This keeps the class as the only user-facing handle
while the tag supplies the runtime identity.

A `ServiceTagLiteral<Tag>` boundary rejects widened `string` and the empty
literal. A runtime empty-tag guard remains defensive only; literal preservation
is a compile-time contract.

### 2. Separate the token constraint from the self-bound token contract

`ServiceToken<Tag, Instance>` describes the constructor-side contract,
including its literal `serviceTag` and the self type used by the declaration;
`AnyServiceToken` is the widened constraint used by internal generic bounds.
Public requirement metadata carries the exact tag and self-bound contract, for
example `ServiceToken<'Database', Database>`. The resolver still accepts the
concrete constructor (`typeof Database`) and returns its exact `InstanceType`.
`ServiceInstance<T>` remains `InstanceType<T>`, and Service method requirement
extraction continues to walk that instance type.

This removes the old `ServiceToken<Instance>` meaning rather than supporting two
identity models in parallel. Public type tests and examples migrate to
self-bound tag contracts and, where useful, a `ServiceTag<T>` projection. The
self type is the inference anchor; the tag remains the runtime/logical identity.

### 3. Compare tags first, then contracts

Layer inference defines internal predicates equivalent to:

```text
SameServiceTag<L, R>
  = bidirectional equality of L['serviceTag'] and R['serviceTag']

SameServiceContract<L, R>
  = bidirectional assignability of InstanceType<L> and InstanceType<R>

SameServiceToken<L, R>
  = SameServiceTag<L, R> && SameServiceContract<L, R>
```

Different tags never satisfy one another, even with identical shapes. Same-tag
incompatible contracts do not satisfy one another. The predicates stay internal;
the public API exposes the tag-aware self-bound contracts in diagnostics rather
than helper predicates.

### 4. Make Layer composition the collision boundary

`Layer.merge` preflights providers by `serviceTag` and throws the existing
duplicate-service error (updated to report the tag) when a tag is claimed twice.
`Layer.override` uses the same tag/contract identity for its type-level
replacement calculation and for runtime provider selection. A same-tag
replacement that is not contract-compatible is rejected instead of leaving a
Layer whose type describes a provider that runtime has replaced with another
contract.

TypeScript contracts are erased at runtime, so runtime checks do not attempt to
reconstruct full method signatures. The typed Layer boundary is authoritative
for structural compatibility; runtime retains the provider constructor
alongside the tag, rejects duplicate registration, and performs a best-effort
prototype-member check when a different constructor is requested for the same
tag. It fails with a collision error when that association is visibly
incompatible. Unparameterized/`any` escape hatches remain explicitly unchecked,
as they are today, rather than gaining a second nominal metadata system.

### 5. Key bundled backends by tag

The testing Memory backend uses `Map<string, ...>` for providers, cached
instances, and pending acquisitions. ITI derives a deterministic internal key
from the tag and tracks registered tags in the backend instance. Both backends
retain the constructor in each registration for diagnostics and association
checks. `ServiceRuntime` remains a resolver bridge and does not import or know
about either backend.

### 6. Keep structural providers and lifecycle semantics unchanged

`Layer.succeed` and other creation boundaries continue to accept values
assignable to `InstanceType<S>`; implementations do not declare `serviceTag`.
Provider release callbacks remain owned by Scope, and pipeline, Resource,
better-result, and graceful Runtime disposal code is not redesigned as part of
identity migration.

### 7. Migrate in proof-first phases

The first code change is an isolated type experiment proving exact `yield*` and
`EffectRequirements` inference. Only after that proof passes will the Service
types and repository declarations migrate. Runtime backend changes follow the
type-level contract, then examples/docs and the full quality gate are updated.

## Risks / Trade-offs

- **[Structural contracts are erased at runtime]** → Enforce tag/contract
  compatibility at typed Layer/Runtime boundaries, retain registering tokens
  for diagnostics, and reject duplicate/unreconcilable runtime associations;
  do not claim runtime reflection can prove arbitrary TypeScript types.
- **[Simple tags can collide across packages]** → Keep simple names as the
  default DX and document namespaced tags such as `@acme/Database` for public
  libraries or shared environments.
- **[The public `ServiceToken` generic changes meaning]** → Treat the migration
  as a breaking pre-1.0 change, update all type tests/docs, and do not maintain
  a silent dual syntax.
- **[Tag-keyed maps change duplicate behavior]** → Add runtime coverage for
  duplicate merge, compatible override, different-tag isolation, caching,
  pending acquisition de-duplication, and ITI disposal before release.
- **[Existing untracked characterization tests may belong to the user]** →
  Preserve unrelated work and adapt identity tests deliberately rather than
  deleting them.

## Migration Plan

1. Add the isolated tagged-Service type proof and reject the old inference only
   after exact instance inference and tagged requirement contracts are
   demonstrated.
2. Refactor Service declarations/types and update Service-specific tests.
3. Update Effect requirement propagation and Layer comparison predicates.
4. Update Layer merge/override runtime identity and both bundled backends.
5. Add/update collision, different-tag, override, Runtime, pipeline, generator,
   structural-mock, and ITI tests.
6. Migrate the TODO example, README, AGENTS invariants, and all remaining
   declarations/type assertions.
7. Run typecheck, tests, lint, format check, build, publint, and package dry
   run. Do not publish automatically.

Rollback is a normal source revert or release of the preceding version; no
dual-runtime compatibility layer is introduced.

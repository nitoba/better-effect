## Context

`Scope.add` already detects `Symbol.asyncDispose` and `Symbol.dispose`, registers the selected function as a Scope finalizer, and immediately disposes a resource when registration loses a race with Scope closure. `Effect.acquireRelease` demonstrates the existing async-yieldable pattern for delegating resource ownership to the contextual Scope while using `better-result` for registration/acquisition failures.

The exported `DisposableResource` currently makes both symbol members optional. Structurally, that allows any object—including `{}`—through the TypeScript boundary even though `Scope.add` rejects it at runtime.

## Goals / Non-Goals

**Goals:**

- Expose existing disposable registration naturally inside async `Effect.gen`.
- Preserve the exact resource subtype and Effect metadata.
- Require at least one disposal protocol at typed public boundaries.
- Keep dynamic validation for unsafe and untyped inputs.
- Reuse Scope cleanup, ordering, race handling, and diagnostics without duplicating them in Effect.

**Non-Goals:**

- Acquiring or constructing the resource inside `Effect.add`.
- Supporting explicit release callbacks; `Effect.acquireRelease` remains that API.
- Passing `ScopeOutcome` to JavaScript disposal protocol methods.
- Adding `Effect.scoped`, child-Scope helpers, cancellation, or Resource changes.
- Deduplicating repeated registration of the same object.

## Decisions

### Implement Effect.add as an async yieldable over Scope.add

The public shape will be equivalent to:

```ts
Effect.add(resource)
// AsyncGenerator<Err<never, UnhandledException>, typeof resource, unknown>
```

It obtains the current non-owning Scope and delegates to `scope.add(resource)` through the same `Result.tryPromise` plus `Result.await` pattern used by `Effect.acquireRelease`. The helper neither accepts an acquire callback nor creates a Scope, so ownership remains explicit: the resource must already exist when passed in.

Registration failures from an available Scope use `UnhandledException` in the Effect error channel. Resolving the current Scope remains outside that conversion so missing context preserves the established `Effect.acquireRelease` behavior.

Alternative considered: accept an acquisition callback. Rejected because it would duplicate `Effect.acquireRelease` and blur the distinction between explicit release and protocol-based registration.

### Represent DisposableResource as a union with one required protocol

The public type will be structurally equivalent to a union of:

```ts
type SyncDisposableResource = {
  [Symbol.dispose]: () => void
  [Symbol.asyncDispose]?: () => MaybePromise<void>
}

type AsyncDisposableResource = {
  [Symbol.dispose]?: () => void
  [Symbol.asyncDispose]: () => MaybePromise<void>
}

type DisposableResource = SyncDisposableResource | AsyncDisposableResource
```

This accepts either protocol and objects implementing both while rejecting plain objects. The library keeps its own structural type rather than depending on a separate runtime package or broadening the API to arbitrary `unknown`.

This is intentionally source-breaking for callers that pass a value whose static type does not expose either method. Such callers must narrow the value, improve its declared type, or use an explicit cast at a genuinely dynamic boundary.

### Preserve runtime validation and async-first selection

Type safety cannot protect JavaScript consumers, `any`, or assertions. `Scope.add` therefore retains `getDisposeFinalizer` and `ResourceNotDisposableError`. Selection remains `Symbol.asyncDispose` first, then `Symbol.dispose`, with method invocation bound to the resource object.

The internal detector may accept `unknown` or a partial candidate during validation even though public registration requires `DisposableResource`. This keeps the unsafe cast at the runtime-check boundary rather than weakening the exported type.

### Keep disposal failures in Scope cleanup

Once `Effect.add` successfully registers, its Result has succeeded and later disposer failures belong to Scope closure. Runtime outcome classification, LIFO ordering, cleanup diagnostics, and program-versus-cleanup precedence remain unchanged. JavaScript disposal methods receive no `ScopeOutcome`; callers needing outcome-aware cleanup use `Effect.acquireRelease`.

## Risks / Trade-offs

- [Narrowing `DisposableResource` breaks weakly typed callers] → Mark the change as breaking, add negative type tests, and document narrowing/casting migration paths.
- [An already-created resource may leak when no Scope exists] → Preserve the established missing-context behavior and document that callers must invoke `Effect.add` inside a managed Scope; the helper cannot own a resource without a Scope.
- [Users may assume Effect.add performs acquisition] → Name and examples consistently describe registration of an already-acquired object and direct explicit acquisition/release to `Effect.acquireRelease`.
- [Two registrations dispose the same object twice] → Keep one finalizer per call, matching `Scope.add`; deduplication would add identity tracking and surprising ownership semantics.

## Migration Plan

Add `Effect.add` as an additive API. For the narrowed type, update compile failures by declaring the actual disposal symbol on the resource type or narrowing dynamic inputs before registration. Runtime validation remains as a safety net, so no data or lifecycle migration is required. Rollback removes `Effect.add` and restores the all-optional disposable shape; existing Scope runtime behavior remains otherwise unchanged.

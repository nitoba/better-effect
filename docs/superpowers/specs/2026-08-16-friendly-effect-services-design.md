# Friendly Effect Services Design

## Summary

Add a type-only `Effect.Services<T>` projection that presents an Effect program's Service requirements as instance types such as `Database | Logger`, while retaining exact tagged Service tokens as the canonical requirement representation used by `EffectResult`, Layer composition, and Runtime validation.

Close the existing type-safety loophole that permits `EffectResult<A, E, Database>` even though instance-side requirements are ignored by token-based completeness checks.

## Goals

- Make inferred Effect dependencies easier to read through `Effect.Services<T>`.
- Preserve tag-aware Service identity throughout Effect, Layer, and Runtime internals.
- Reject invalid instance-side arguments to `EffectResult` at the annotation site.
- Preserve all existing runtime behavior and emitted JavaScript.
- Support TypeScript 5.2.2 and the current project compiler.

## Non-goals

- Do not replace `Effect.Requirements<T>` or change its token-based semantics.
- Do not change the canonical third parameter of `EffectResult` to an instance type.
- Do not move Service identity from the constructor to the instance side.
- Do not promise a particular TypeScript hover rendering for an entire Effect result.
- Do not add runtime metadata, values, or dependencies.

## Current model

A yielded Service contributes its constructor-backed token to the Effect requirement channel:

```text
yield* Database
      │
      ▼
ServiceRequirement<ServiceToken<'Database', Database>>
      │
      ▼
EffectResult<User, UserError, typeof Database>
      │
      ▼
Layer and Runtime compare literal tags and instance contracts
```

The token is required because the constructor carries `serviceTag`. Instance types alone cannot preserve identity: two Services with different tags may have structurally identical instances.

`EffectResult` currently leaves `Requirements` unconstrained. Consequently, this annotation compiles:

```ts
type Invalid = EffectResult<User, Error, Database>
```

`MissingServices` processes only `AnyServiceToken`, so the instance-side `Database` falls through to `never` and is treated as no requirement. This is an unsafe unchecked path rather than a supported spelling.

## API design

### Canonical requirements remain tokens

Constrain the requirement parameter at its source:

```ts
export type EffectResult<
  A,
  E,
  Requirements extends AnyServiceToken = never
> = ResultType<A, E> & {
  readonly [EffectRequirementsTypeId]?: Requirements
}
```

Valid annotations remain unchanged:

```ts
type NeedsDatabase = EffectResult<User, UserError, typeof Database>
```

Invalid instance-side annotations fail where they are declared:

```ts
// Type error: Database is not an AnyServiceToken
type Invalid = EffectResult<User, UserError, Database>
```

Generic helpers that construct `EffectResult` must carry the same token constraint. This strengthens only malformed requirements and preserves valid token unions, `never`, and the intentional `any` erasure used by `AnyEffectResult`.

### Friendly instance projection

Add the public prefixed helper:

```ts
export type EffectServices<T> = EffectRequirements<T> extends infer Requirements
  ? Requirements extends AnyServiceToken
    ? InstanceType<Requirements>
    : never
  : never
```

The nested distributive conditional projects each member of a token union independently.

Expose the discoverable namespace alias:

```ts
export declare namespace Effect {
  export type Services<T> = EffectServices<T>
}
```

Usage:

```ts
const program = Effect.gen(async function* () {
  const database = yield* Database
  const logger = yield* Logger

  return Result.ok({ database, logger })
})

type Requirements = Effect.Requirements<typeof program>
// ServiceToken<'Database', Database> | ServiceToken<'Logger', Logger>

type Services = Effect.Services<typeof program>
// Database | Logger
```

`EffectServices<T>` and `Effect.Services<T>` are exact aliases. They are type-only and add no JavaScript.

## Relationship to Effect TS

Effect TS can expose a simpler-looking environment parameter because its Context Tag model places dependency identity on a tag's instance-side type. In better-effect, the Service class constructor is simultaneously the resolver token and owner of the stable `serviceTag`, while the instance is the implementation contract.

This change provides equivalent readability for inspection:

```ts
type Required = Effect.Services<typeof program>
```

It deliberately does not claim that the complete inferred `EffectResult` hover will replace `typeof Database` with `Database`. TypeScript controls hover formatting, and the canonical result must retain constructor tokens for tag-aware validation.

## Data flow

```text
                           canonical, tag-aware
Effect program ──────────▶ Effect.Requirements<T> ─────▶ Layer / Runtime checks
         │                         │
         │                         │ distributive InstanceType projection
         │                         ▼
         └────────────────▶ Effect.Services<T>
                            Database | Logger
                            presentation / inspection
```

The friendly projection is one-way. It is never fed back into Layer completeness or Runtime execution validation.

## Compatibility

### Preserved

- Existing valid `EffectResult<A, E, typeof Service>` annotations.
- Inferred requirements from `Effect.gen`.
- Requirement propagation through pipeline combinators.
- `Effect.Requirements<T>` and `EffectRequirements<T>` token semantics.
- Layer tag and bidirectional instance-contract comparisons.
- Runtime execution validation and diagnostics.
- Runtime JavaScript and package tree-shaking behavior.

### Intentionally rejected

- `EffectResult<A, E, ServiceInstance>` and any other non-token requirement argument.

This code was previously accepted but semantically unsafe because the execution validator ignored it.

## Testing

Type-contract tests must prove:

- `EffectResult<A, E, Database>` is rejected at the annotation site.
- `EffectResult<A, E, typeof Database>` remains valid.
- unions of Service tokens remain valid.
- `Effect.Services<T>` produces exactly `Database | Logger` for a two-Service program.
- `Effect.Services<T>` produces `never` for a requirement-free program.
- `Effect.Requirements<T>` continues to produce the exact token union.
- pipeline combinators retain tokens internally and project all resulting instances.
- `Effect.Services<T>` and `EffectServices<T>` are exactly equivalent.
- built package declarations expose both spellings under the current compiler and TypeScript 5.2.2.
- generated JavaScript contains no namespace runtime object or requirement metadata.

Documentation should explain that `Effect.Requirements<T>` is the exact tag-aware representation and `Effect.Services<T>` is the readable instance projection.

## Affected areas

- `packages/better-effect/src/effect/types.ts`
- `packages/better-effect/src/effect/effect.ts`
- `packages/better-effect/src/effect/index.ts`
- `packages/better-effect/src/index.ts`
- Effect, pipeline, namespace, and built-package type tests
- public declaration/variance checks where generic signatures are asserted
- `packages/better-effect/README.md`
- `apps/docs/content/docs/effects.mdx`
- `apps/docs/content/docs/services.mdx`
- relevant OpenSpec typed requirement contracts

## Acceptance criteria

- Invalid instance-side Effect requirements no longer compile.
- `Effect.Services<typeof program>` is exactly the required Service instance union.
- canonical token metadata and all tag-aware validation remain unchanged.
- no runtime output or behavior changes.
- the full repository check passes, including TypeScript 5.2.2 package fixtures.

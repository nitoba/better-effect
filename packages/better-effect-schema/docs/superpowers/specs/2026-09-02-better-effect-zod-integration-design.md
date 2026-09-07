# better-effect-zod Integration Design

## Purpose

`better-effect-zod` is the optional Zod-backed data modeling package for the better-effect ecosystem. It turns Zod object schemas and bidirectional codecs into real TypeScript classes while preserving the three distinct representations of a model:

```text
encoded input  ->  decoded constructor props  ->  class instance
```

It also provides typed Result boundaries for decoding, encoding, and construction, and makes schema-backed tagged errors use the exact `better-result` tagged-error runtime protocol.

## Package boundary

The package lives independently under `packages/better-effect-zod` when copied into the monorepo. The core `better-effect` package neither imports nor re-exports it. Runtime dependencies flow in one direction:

```text
better-effect-zod -> zod
better-effect-zod -> better-result
better-effect-zod -type-only-> better-effect
```

Zod, better-result, better-effect, and TypeScript are peer dependencies. Development versions are pinned in the package workspace. The published package is ESM-only because better-result is ESM-only.

## Public API

The preferred facade is `Schema`:

```ts
import { Schema } from "better-effect-zod"

class User extends Schema.Class<User>("@app/User")({
  id: z.uuid(),
  name: z.string().min(1)
}) {}
```

The root also exports `Class`, `TaggedClass`, `TaggedError`, operations, failure classes, guards, and type aliases. `Z` remains a deprecated runtime and type alias for source migration from the original package.

### Native Zod APIs

Schema classes retain native throwing/safe Zod operations:

```ts
User.parse(encoded)
User.safeParse(encoded)
User.decode(encoded)
User.encode(user)
new User(props)
User.make(props)
User.safeMake(props)
```

These preserve native Zod semantics and errors.

### Result-backed APIs

The `Schema` facade adds explicit expected-failure boundaries:

```ts
Schema.decodeUnknown(User)(unknownValue)
Schema.decode(User)(encodedValue)
Schema.encode(User)(user)
Schema.make(User)(props)
```

They return `Effect<A, E, never>`, whose runtime representation is a `better-result` Result. Async variants return `Promise<Effect<A, E, never>>`. They do not resolve Services and never hide environment requirements.

Expected Zod validation failures become:

- `SchemaDecodeFailure`
- `SchemaEncodeFailure`
- `SchemaConstructionFailure`

Unexpected exceptions raised by user callbacks remain defects and are not converted to typed validation failures.

## Failure safety

Schema failures contain only:

```ts
{
  _tag,
  identifier,
  message,
  issues: [{ code?, path?, message }]
}
```

Issue count, message length, code length, and path length are bounded. Unsupported path segments are discarded. Original values are never copied into public failure fields. The originating `ZodError` is retained as a non-enumerable in-memory `cause` and omitted from `toJSON`.

## Tagged errors

`Schema.TaggedError` uses `better-result.TaggedError(tag)` as its root JavaScript base. A decoded or directly constructed error therefore supports all ecosystem behavior:

- `instanceof Error`
- concrete static `.is`
- `better-result.TaggedError.is`
- `_tag`
- `.match(...)`
- direct `yield* error` short-circuiting
- `toJSON()`

The schema layer still validates fields, injects `_tag`, encodes instances, supports class identity and inheritance, and exposes the normal schema-class surface. `_tag`, `name`, `stack`, `match`, and `toJSON` are reserved schema field names.

## Construction safety

Normal constructors, `make`, `makeAsync`, `safeMake`, and `safeMakeAsync` always validate decoded props. The public `{ disableChecks: true }` escape is removed. Explicit unchecked construction is available only through `unsafeMake`, making invariant bypass visible at the call site. Internal codec construction uses a private prevalidated context and does not expose a token.

## Integration recipes

### Kysely

Kysely query execution remains native. Rows are decoded after `$call(KyselyEffect.execute...)`:

```ts
const row = yield* query.$call(KyselyEffect.executeTakeFirstOrFail(...))
const user = yield* Schema.decodeUnknown(User)(row)
```

### better-effect-mq

A schema class implements Standard Schema through Zod. It can be supplied to `Codec.standardSchema`. Class outputs are not necessarily JSON-safe, so persistence uses an explicit encode callback that delegates to the schema class encoder.

### HTTP

Framework adapters parse bytes/JSON and then call `Schema.decodeUnknown`. Mapping `SchemaDecodeFailure` to status 400 belongs to the HTTP boundary, not this package.

## Validation boundary

Schemas validate structure and deterministic representation transforms. Rules requiring repositories, clocks, authorization, network services, or other dependencies remain ordinary application Effects so their Service requirements stay visible.

## Non-goals

- Reimplementing Effect Schema or its AST.
- Adding an Effect runtime, fibers, or schema environment.
- Making Zod a dependency of better-effect core.
- Running database or network validation inside schema callbacks.
- Automatically serializing arbitrary classes, Date, Error, bigint, Map, or Set.
- Shipping Kysely or MQ runtime adapters in the initial package.

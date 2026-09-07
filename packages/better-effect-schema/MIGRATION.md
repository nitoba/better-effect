# Migration guide

This release completes the provider-neutral schema cutover. The root package
no longer owns a Zod runtime, exports a Zod namespace, or exposes compatibility
aliases for the former class API.

## Choose a provider

Portable code uses the root entrypoint and Standard Schema definitions:

```ts
import { Schema } from 'better-effect-schema'
```

Zod code opts in explicitly:

```ts
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'

const Local = Schema.with(ZodAdapter)
class User extends Local.Class<User>('app/User')({ /* Zod fields */ }) {}
```

Equivalent adapters are available from `better-effect-schema/valibot` and
`better-effect-schema/arktype`.

## Replace class-boundary calls

| Former call | New call |
| --- | --- |
| provider class construction at an unknown boundary | `Schema.decodeUnknown(Model, input)` |
| typed provider decode | `Schema.decode(Model, encodedInput)` |
| validated props construction | `Schema.make(Model, props)` or `Model.make(props)` |
| explicit encode | `Schema.encode(Model, instance)` |
| async boundary | `Schema.decodeAsync` / `Schema.encodeAsync` / `Schema.makeAsync` |
| provider capability | `Schema.with(Adapter)` |

The new calls return `Result`-backed `Effect` values. Use `Result.isError` at a
boundary or `yield*` inside `Effect.gen`/`Result.gen`.

There is no parser convenience or throwing class-boundary API in the new
surface. Expected failures are values, not exceptions.

## Explicit codecs

Encoding is never inferred from a one-way schema. Supply an explicit codec with
`schema`, `encodedSchema`, and `encode`, or use a provider-native bidirectional
schema through the adapter. The encoder runs once and its result is validated
at the encoded boundary.

## Tagged values

`Schema.TaggedClass` and `Schema.TaggedError` now accept Standard Schema fields.
For provider-native fields, use the provider facade:

```ts
const Local = Schema.with(ZodAdapter)
class NotFound extends Local.TaggedError<NotFound>()('NotFound', {
  id: z.uuid()
}) {}
```

The `_tag` is injected by construction and cannot be supplied as a user field.
Tagged errors retain the `better-result.TaggedError` protocol and can be
yielded directly.

## Dependency and import changes

The root package has no active Zod dependency. Install only the adapter peer
needed by an application and import it from the matching subpath. Do not add
Zod, Valibot, or ArkType imports to core application-neutral modules.

# Schema: native providers, portable Result boundaries

Package: `better-effect-schema`. This replaces the old package name in new
code; do not assume `better-effect-zod` is an installed compatibility shim.
Public reference: [Schema API](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-schema/docs/api.md).

## Choose the provider at the definition boundary

The root is provider-neutral Standard Schema. Optional `/zod`, `/valibot`, and
`/arktype` subpaths expose preconfigured `Schema` facades and adapters. Keep
native `z.object`, Valibot schemas, or ArkType definitions; do not hand-write
`~standard` validators when the provider already implements the protocol.
Import only providers the application actually uses.

```ts
import * as z from 'zod'
import { Schema } from 'better-effect-schema/zod'
import { Schema as CoreSchema } from 'better-effect-schema'
import { Effect } from 'better-effect'
import { Result } from 'better-result'

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class Event extends Schema.Class<Event>('@app/Event')({
  id: z.string().min(1),
  occurredAt: DateFromISOString
}) {}

const validateEvent = (input: unknown) =>
  Effect.fn(function* () {
    const event = yield* Schema.decodeUnknown(Event, input)
    const wire = yield* CoreSchema.encode(Event, event)
    return Result.ok({ event, wire })
  })
```

The successful `event` is an Event instance with a Date. `wire` is the explicit
encoded representation. Use `event` in domain code and `wire` at transport
boundaries; the default Web JSON policy does not serialize arbitrary classes.

For other providers, import the matching facade:

```ts
import { Schema as ValibotSchema } from 'better-effect-schema/valibot'
import { Schema as ArkTypeSchema } from 'better-effect-schema/arktype'
```

Then pass the application's native schema to that facade's operations.
Providers can coexist; there is no global provider setting.

## Select the operation by the input you actually have

| Operation | Input and intent |
| --- | --- |
| `Schema.decodeUnknown(schema, input)` | Untrusted unknown input |
| `Schema.decode(schema, input)` | The schema's encoded input type is already known |
| `Schema.make(schemaClass, props)` | Decoded construction props, not wire input |
| `Schema.encode(schema, value)` | Explicit domain-to-wire capability |
| `decodeUnknownAsync`, `decodeAsync`, `makeAsync`, `encodeAsync` | Async counterparts; consume the returned async Result |

Direct and curried decode forms are public. Use the exact installed operation
return type: synchronous Results are directly yieldable; async Results can be
consumed with `yield* Result.await(...)`. Finish the enclosing Effect generator
with `Result.ok(...)`, even when a documentation fragment shows a raw return.
Do not rerun decoding on an already-decoded Date/class: transforms need not be
idempotent. `Schema.Input`, `Output`, `Props`, `Encoded`, `Instance`, and `Fields`
are distinct type projections, not interchangeable aliases.

Use `.make`/`Schema.make` rather than unchecked constructors or `.unwrap()` for
untrusted input. `Schema.TaggedClass` and `Schema.TaggedError` provide stable
_tags for portable domain values/errors. Provider-native class construction,
derivation, fields, and JSON Schema conversion remain capability-dependent:
consult the matching provider guide before using them. `Schema.with` is for
custom adapters/capability configuration, not routine global configuration.

## Failure channels and capability limits

Validation returns `SchemaDecodeFailure`; construction and encoding have their
own failures. Invalid definitions are `SchemaDefinitionFailure`. Provider,
constructor, or callback throws/rejections crossing the wrapped boundary are
represented by `SchemaExecutionFailure`. A sync operation encountering async
work returns `SchemaAsyncRequired`; use the async operation instead of retrying
the validator through multiple paths.

Standard Schema is validation/decode interoperability, **not** universal
reflection or reversible encoding. An unavailable capability returns
`SchemaUnsupportedOperation`. Do not invent an inverse transform, cast the
output back to the input type, or use identity encoding as a fallback.
Normalized issues are suitable for intentional error mapping; do not expose raw
provider objects or untrusted input in diagnostics.

## HTTP, configuration, and MQ

HTTP `schema`/`responses` accept Standard Schema values without importing a
provider into the HTTP package. Native provider schemas and schema classes both
work; preserve the actual decoded output rather than cloning it into a record.
For a domain request body differing from wire data, use an explicit endpoint
`bodyCodec`, not a guessed reverse transform. See [HTTP](http-client.md).

For configuration, define a provider-native schema and use the core Config
boundary for source reading and validation. Do not scatter `process.env` reads
through Services or replace typed failures with thrown validation exceptions.

MQ's codec must separate enqueue input, decoded handler payload, and persisted
JSON. With the Event class above:

```ts
import { Codec, JobEncodeFailure } from 'better-effect-mq'

const EventPayload = Codec.standardSchema({
  schema: Event,
  encode: (event) =>
    CoreSchema.encode(Event, event).mapError(
      (error) => new JobEncodeFailure({ message: error.message, code: 'schema-encode' })
    )
})
```

For untrusted data, prefer this schema-backed boundary over `Codec.json<T>()`,
which does not validate the TypeScript shape. An explicit encoder is needed
when the decoded output is not already the intended JSON-safe wire value.
See the [MQ codec example](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-mq/README.md).

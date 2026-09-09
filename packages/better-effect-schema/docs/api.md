# API reference

This package puts one provider-neutral boundary around native schema
libraries. Define schemas with Zod, Valibot, or ArkType, then import the
preconfigured `Schema` facade from the matching provider subpath when you need
the package's `Result`-backed operations.

## Imports and provider boundaries

The root entrypoint contains the portable operations and failure types:

~~~ts
import * as z from 'zod'
import { Schema as CoreSchema, SchemaDecodeFailure } from 'better-effect-schema'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema/zod'
~~~

Provider integrations are optional peers and use package subpaths. Choose Zod
for its broad ecosystem and class/codec support, Valibot for modular schemas
and small bundles, or ArkType for concise definitions with inferred runtime
types and structural errors:

~~~ts
import { Schema as ZodSchema } from 'better-effect-schema/zod'
import { Schema as ValibotSchema } from 'better-effect-schema/valibot'
import { Schema as ArkTypeSchema } from 'better-effect-schema/arktype'
~~~

Each provider subpath exports a ready-to-use `Schema` facade:

~~~ts
class User extends Schema.Class<User>('app/User')({
  id: z.string()
}) {}
~~~

Use the matching alias when more than one provider is present in one module:

~~~ts
const valibotResult = ValibotSchema.decodeUnknown(valibotSchema, value)
const arktypeResult = ArkTypeSchema.decodeUnknown(arktypeSchema, value)
~~~

The root entrypoint remains provider-neutral for Standard Schema definitions,
portable operations, and failure types. There is no global provider setting, so
different provider subpaths can coexist in one application. `Schema.with` is
reserved for authoring a custom adapter or intentionally configuring a custom
capability set.

## Decode untrusted input

Use `Schema.decodeUnknown` when data is `unknown`:

~~~ts
const decoded = Schema.decodeUnknown(User, untrustedValue)
if (Result.isError(decoded)) {
  console.error(decoded.error._tag)
  console.error(decoded.error.issues)
} else {
  const user = decoded.value
}
~~~

Use `Schema.decode` when the input already matches the schema's encoded input
type. Both operations support direct and curried forms:

~~~ts
Schema.decode(User, encodedValue)
Schema.decode(User)(encodedValue)
Schema.decodeUnknown(User, unknownValue)
Schema.decodeUnknown(User)(unknownValue)
~~~

The operations validate with Standard Schema and construct a schema class when
the input is a class. A successful operation returns a `Result.ok` value; an
expected validation failure returns `Result.err`.

For asynchronous provider schemas, use the corresponding async operation:

~~~ts
await Schema.decodeAsync(User, encodedValue)
await Schema.decodeUnknownAsync(User, unknownValue)
~~~

Calling a synchronous operation with an async schema returns
`SchemaAsyncRequired`; it does not run the validator a second time.

## Construct and encode

`Schema.make` validates decoded constructor props before constructing a class.
Use it when your application already has decoded data but still wants the
class's construction contract:

~~~ts
const made = CoreSchema.make(User, { id: 'user-1' })
if (Result.isError(made)) throw made.error
~~~

Encoding is explicit. A class or codec needs an encoding function; the package
does not treat a read-only schema as its own inverse:

~~~ts
const encoded = CoreSchema.encode(Event, event)
if (Result.isError(encoded)) throw encoded.error

const encodedAsync = await CoreSchema.encodeAsync(Event, event)
~~~

When a provider schema has no encoding capability, the result is
`SchemaUnsupportedOperation`. Provider codecs, such as a Zod `z.codec`, are
the usual way to define a reversible transport boundary.

## Failure handling

All expected failures are `better-result` values. At an imperative boundary,
branch with `Result.isError`:

~~~ts
const result = Schema.decodeUnknown(User, value)
if (Result.isError(result)) {
  const failure = result.error
  console.error(failure._tag, failure.message, failure.issues)
  return
}

useUser(result.value)
~~~

The public failure classes are:

| Failure | Meaning |
| --- | --- |
| `SchemaDecodeFailure` | Input failed schema validation. |
| `SchemaConstructionFailure` | Decoded props could not construct the class. |
| `SchemaEncodeFailure` | An explicit encoder returned invalid output. |
| `SchemaDefinitionFailure` | The schema or class declaration is invalid. |
| `SchemaExecutionFailure` | A provider, constructor, or callback threw or rejected. |
| `SchemaAsyncRequired` | A synchronous call received an async schema or operation. |
| `SchemaUnsupportedOperation` | The selected provider cannot perform the requested operation. |

`failure.issues` is a normalized, serialization-safe list. Provider-native
details remain available when you use the provider directly (`ZodError.issues`,
Valibot `issues`, or ArkType `type.errors`).

## Type inspection

Use the `Schema` namespace helpers when a public type needs to refer to a
provider-neutral projection:

~~~ts
type Input = Schema.Input<typeof User>
type Output = Schema.Output<typeof User>
type Props = Schema.Props<typeof User>
type Encoded = Schema.Encoded<typeof User>
type Instance = Schema.Instance<typeof User>
type Fields = Schema.Fields<typeof User>
~~~

Provider adapters retain richer native types for provider-specific APIs. Keep
those native types at the provider boundary and expose application types from
your own domain modules.

## Result and Effect integration

Schema operations are ordinary `better-effect` `Effect` values with no service
requirements. Yield one in an `Effect.gen` workflow:

~~~ts
import { Effect } from 'better-effect'

const program = Effect.gen(function* () {
  const user = yield* Schema.decodeUnknown(User, untrustedValue)
  return user.displayName
})
~~~

The `Result` failure remains the same value whether you inspect it directly or
yield it from a generator.

## Advanced: custom-provider authoring

Most users should choose a native provider. Hand-writing the Standard Schema
contract is an unusual escape hatch for a project-specific validator or an
adapter author.

The minimum `StandardSchemaV1` shape has a `~standard` member with version,
vendor, and a `validate` function. A synchronous validator returns either a
`value` or an `issues` list:

~~~ts
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Schema } from 'better-effect-schema'

const UserSchema: StandardSchemaV1<{ id: string }, { id: string }> = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate(value) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { id?: unknown }).id === 'string'
      ) {
        return { value: value as { id: string } }
      }

      return { issues: [{ message: 'Expected an object with a string id' }] }
    }
  }
}

const result = Schema.decodeUnknown(UserSchema, { id: 'user-1' })
~~~

Prefer the provider's public API when one exists. If the custom validator is
async, return a promise and call `Schema.decodeUnknownAsync`. The package
normalizes provider issues into `SchemaDecodeFailure`; it does not require
consumers to know the custom validator's implementation.

## Provider guides

- [Zod adapter](zod.md)
- [Valibot adapter](valibot.md)
- [ArkType adapter](arktype.md)

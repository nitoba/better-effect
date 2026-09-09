# Valibot adapter

Use `better-effect-schema/valibot` when your application already uses Valibot
schemas. Valibot keeps its modular, function-based API; the adapter connects
those native schemas to the same package-level decode and failure model used by
the other providers.

## Install

~~~sh
bun add better-effect-schema valibot better-result
~~~

Import Valibot and the adapter from their normal entrypoints:

~~~ts
import * as v from 'valibot'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema/valibot'
~~~

## Define and validate a Valibot schema

Define an object schema with Valibot's composable functions and infer its
input/output types:

~~~ts
const UserSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  email: v.pipe(v.string(), v.email()),
  displayName: v.pipe(v.string(), v.minLength(1))
})

type UserInput = v.InferInput<typeof UserSchema>
type User = v.InferOutput<typeof UserSchema>

const input: unknown = {
  id: 'user-1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace'
}
~~~

Valibot's native boundary returns a discriminated result with either
`output` or `issues`:

~~~ts
const checked = v.safeParse(UserSchema, input)
if (checked.success) {
  const user: User = checked.output
  console.log(user.displayName)
} else {
  console.error(checked.issues)
}
~~~

For a provider-neutral package boundary, use the preconfigured `Schema` facade and call
`decodeUnknown`. The successful value retains the Valibot output type, and failures
are `Result.err` values with normalized issues:

~~~ts
const decoded = Schema.decodeUnknown(UserSchema, input)

if (Result.isError(decoded)) {
  console.error(decoded.error._tag) // SchemaDecodeFailure
  console.error(decoded.error.issues)
  throw decoded.error
}

const user: User = decoded.value
console.log(`Welcome ${user.displayName}`)
~~~

Use `Schema.decode` when the input has the schema's inferred input type, and
`Schema.decodeUnknown` when the value is truly `unknown`:

~~~ts
const fromBoundary = Schema.decodeUnknown(UserSchema, input)
if (Result.isError(fromBoundary)) throw fromBoundary.error
~~~

## Construction and structural capabilities

Valibot is a native-schema adapter rather than a class factory. Use
`Schema.make` when you want the package to validate props and then construct a
domain value:

~~~ts
const descriptor = {
  schema: UserSchema,
  propsSchema: UserSchema,
  construct: (props: User) => ({ ...props, kind: 'user' as const })
}

const made = Schema.make(descriptor, {
  id: 'user-1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace'
})
if (Result.isError(made)) throw made.error
console.log(made.value.kind)
~~~

The facade also exposes provider-owned structure and derivation operations where
Valibot can preserve the schema's semantics:

~~~ts
const fields = Schema.fields(UserSchema)
if (Result.isError(fields)) throw fields.error

const PartialUserSchema = Schema.derive(UserSchema, 'partial')
if (Result.isError(PartialUserSchema)) throw PartialUserSchema.error
~~~

Validation and read-only pipelines are preserved. Object transformations,
unsupported shape operations, and missing inverse encoders return typed
`SchemaUnsupportedOperation` failures instead of silently changing behavior.
Async Valibot schemas require the corresponding async package operation.

## Provider-neutral model

Valibot remains the schema authoring and native-validation layer. The adapter
only supplies the bridge that lets `better-effect-schema` use the schema with
the same `Result`-backed operations as Zod and ArkType. Choose Valibot when
its modular API, small bundles, and functional schema composition fit your
application.

## Further reading

- [Valibot documentation](https://valibot.dev/)
- [Provider-neutral API reference](api.md)
- [Zod adapter](zod.md)
- [ArkType adapter](arktype.md)

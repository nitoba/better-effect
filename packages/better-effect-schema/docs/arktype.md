# ArkType adapter

Use `better-effect-schema/arktype` when your application already uses ArkType
definitions. ArkType keeps its concise type syntax and runtime inference; the
adapter connects native ArkType types to the same package-level decode and
failure model as the other providers.

## Install

~~~sh
bun add better-effect-schema arktype better-result
~~~

Import the native `type` builder and the adapter from their public entrypoints:

~~~ts
import { type } from 'arktype'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema/arktype'
~~~

## Define and validate an ArkType schema

Define a type with ArkType's object syntax. Its `infer` member is the
provider-inferred TypeScript output type:

~~~ts
const UserSchema = type({
  id: 'string',
  email: 'string.email',
  displayName: 'string'
})

type User = typeof UserSchema.infer

const input: unknown = {
  id: 'user-1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace'
}
~~~

Calling an ArkType definition validates and transforms input. A successful call
returns the inferred value; an invalid call returns `type.errors` with a
human-readable `summary`:

~~~ts
const checked = UserSchema(input)
if (checked instanceof type.errors) {
  console.error(checked.summary)
} else {
  const user: User = checked
  console.log(user.displayName)
}
~~~

For a provider-neutral package boundary, use the preconfigured `Schema` facade and call
`decodeUnknown`. The successful value retains the ArkType output type, and failures
are `Result.err` values with normalized issues:

~~~ts
const decoded = Schema.decodeUnknown(UserSchema, input)

if (Result.isError(decoded)) {
  console.error(decoded.error._tag) // SchemaDecodeFailure
  console.error(decoded.error.issues)
  throw decoded.error
}

const user: User = decoded.value
console.log(user.displayName)
~~~

Use `Schema.decodeUnknown` when the input is not yet typed:

~~~ts
const fromBoundary = Schema.decodeUnknown(UserSchema, input)
if (Result.isError(fromBoundary)) throw fromBoundary.error
~~~

## Structure and derivation

The preconfigured `Schema` facade exposes structural operations supported by ArkType:

~~~ts
const fields = Schema.fields(UserSchema)
if (Result.isError(fields)) throw fields.error

const PartialUserSchema = Schema.derive(UserSchema, 'partial')
if (Result.isError(PartialUserSchema)) throw PartialUserSchema.error
~~~

Use ArkType's native callable definition when you want its `ArkErrors`
instance and summary. Use `Schema.decode` or `Schema.decodeUnknown` when you
want the package's normalized `Result` failure channel and provider-neutral
application code.

## Provider-neutral model

ArkType remains the schema authoring and native-validation layer. The adapter
only supplies the bridge that lets `better-effect-schema` use the type with
the same `Result`-backed operations as Zod and Valibot. Choose ArkType when
concise definitions, inferred runtime types, and detailed structural errors
fit your application.

## Further reading

- [ArkType documentation](https://arktype.io/)
- [Provider-neutral API reference](api.md)
- [Zod adapter](zod.md)
- [Valibot adapter](valibot.md)

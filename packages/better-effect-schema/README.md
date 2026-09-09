# better-effect-schema

Use the schema library your application already uses to validate untrusted
data, construct typed values, and keep expected validation failures in
`better-result` instead of throwing them.

`better-effect-schema` gives Zod, Valibot, and ArkType the same package-level
model:

- provider schemas remain native (`z.object`, `v.object`, or `type({...})`);
- provider adapters connect those schemas to `Schema.decode`, `Schema.make`,
  and the other package operations;
- successful values keep the provider's inferred TypeScript types; and
- expected failures are returned as `Result.err` values with normalized
  `SchemaFailure` issues.

The root entrypoint is provider-neutral. Optional integrations are available
from their own subpaths:

~~~text
better-effect-schema       Standard Schema core and portable operations
better-effect-schema/zod   Zod 4 adapter and class factories
better-effect-schema/valibot
better-effect-schema/arktype
~~~

## Quick start with Zod

Install the package, Zod, and `better-result` for inspecting operation results:

~~~sh
bun add better-effect-schema zod better-result
~~~

Define a real Zod schema, infer the data type you use in your application, and
give the schema to the Zod-backed local facade:

~~~ts
import * as z from 'zod'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'

const local = Schema.with(ZodAdapter)

const UserSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  displayName: z.string().min(1)
})

type UserInput = z.infer<typeof UserSchema>

const example: UserInput = {
  id: 'user-1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace'
}

class User extends local.Class<User>('app/User')(UserSchema) {}
~~~

Validate at the boundary where data is still `unknown`. `Schema.decodeUnknown`
uses the Zod schema and returns a real `User` instance on success:

~~~ts
const input: unknown = JSON.parse('{"id":"user-1","email":"ada@example.com","displayName":"Ada Lovelace"}')
const decoded = Schema.decodeUnknown(User, input)

if (Result.isError(decoded)) {
  console.error(decoded.error._tag) // SchemaDecodeFailure
  console.error(decoded.error.issues) // normalized paths and messages
  throw decoded.error
}

const user: User = decoded.value
console.log(`Welcome ${user.displayName}`)
~~~

Invalid input stays in the same explicit failure channel. You can inspect the
provider's own issues before crossing into the package boundary, or inspect
the normalized `SchemaDecodeFailure` returned by `better-effect-schema`:

~~~ts
const untrusted: unknown = {
  id: 42,
  email: 'not-an-email',
  displayName: ''
}

const zodCheck = UserSchema.safeParse(untrusted)
if (!zodCheck.success) {
  console.error(zodCheck.error.issues)
}

const result = Schema.decodeUnknown(User, untrusted)
if (Result.isError(result)) {
  console.error(result.error.issues)
  // result.error is a SchemaDecodeFailure; no expected validation error was thrown.
}
~~~

The validated value is now an application-level `User`, so pass it to your
normal domain code with its exact class type:

~~~ts
function userLabel(user: User): string {
  return `${user.displayName} <${user.email}>`
}

if (Result.isOk(decoded)) {
  const label = userLabel(decoded.value)
  console.log(label)
}
~~~

Use `Schema.decode` when the input already has the schema's encoded type, and
use `Schema.decodeUnknown` for data from JSON, HTTP, queues, or other untrusted
boundaries. Both operations return `Result` values and can be yielded from a
`better-effect` generator.

## Choose a provider

All three providers plug into the same flow: define a native schema, validate
unknown data, and hand the successful output to the package API. Choose the
provider that best matches the rest of your application:

| Provider | Choose it when | Guide |
| --- | --- | --- |
| Zod | You want a broad ecosystem, codecs, or provider-owned schema classes and derivations. | [Zod guide](docs/zod.md) |
| Valibot | You want a modular API and small bundles while keeping schemas close to ordinary data definitions. | [Valibot guide](docs/valibot.md) |
| ArkType | You prefer concise type syntax with runtime inference and detailed structural errors. | [ArkType guide](docs/arktype.md) |

Each adapter is imported from its package subpath, so applications do not
load other providers accidentally. The provider-neutral operations and failure
types are documented in the [API reference](docs/api.md).

## Zod codecs

When transport and application values differ, define that conversion in a Zod
codec and let the package validate both directions:

~~~ts
const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class Event extends local.Class<Event>('app/Event')({
  id: z.string(),
  occurredAt: DateFromISOString
}) {}

const decodedEvent = Schema.decode(Event, {
  id: 'event-1',
  occurredAt: '2026-09-06T00:00:00.000Z'
})
if (Result.isError(decodedEvent)) throw decodedEvent.error

const wireEvent = Schema.encode(Event, decodedEvent.value)
if (Result.isError(wireEvent)) throw wireEvent.error
~~~

Encoding is explicit. A read-only schema without a codec does not get an
invented inverse encoder.

## Advanced: custom Standard Schema providers

Most applications should use a native provider and its adapter. Hand-writing a
`StandardSchemaV1` object is unusual; use it only when no provider package
fits, or when you are authoring an adapter. The manual contract and its
failure behavior are documented in the [advanced API section](docs/api.md#advanced-custom-provider-authoring).

## Tagged classes and errors

The root facade also exports portable tagged factories. Provider adapters add
their own provider-native class capabilities where supported. Use a provider
schema for ordinary input validation and the tagged factories for domain
values or errors that need a stable tag:

~~~ts
import * as z from 'zod'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'

const local = Schema.with(ZodAdapter)

class UserNotFound extends local.TaggedError<UserNotFound>()('UserNotFound', {
  userId: z.string()
}) {}

const failure = UserNotFound.make({ userId: 'user-1' })
if (Result.isError(failure)) throw failure.error
console.log(failure.value._tag, failure.value.userId)
~~~

## Package checks

The package publishes the provider-neutral root plus the `./zod`, `./valibot`,
and `./arktype` subpaths. Run the checks with Bun from the repository root or
from this package:

~~~sh
bun run typecheck
bun run test
bun run examples
bun run check
~~~

# Zod adapter

Use the Zod adapter when your application already models data with Zod 4.
Your Zod schemas stay native, while `better-effect-schema` gives you a
consistent `Result` boundary and optional schema classes.

## Install

~~~sh
bun add better-effect-schema zod better-result
~~~

Import the adapter from `better-effect-schema/zod`; importing the root package
does not load Zod:

~~~ts
import * as z from 'zod'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'
~~~

## Define and validate a Zod schema

Start with a normal Zod object schema and infer the type you use elsewhere in
your application:

~~~ts
const UserSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  displayName: z.string().min(1)
})

type UserInput = z.infer<typeof UserSchema>

const input: unknown = {
  id: 'user-1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace'
}
~~~

Zod's own `safeParse` is useful when you want provider-specific
`ZodError.issues`:

~~~ts
const checked = UserSchema.safeParse(input)
if (!checked.success) {
  console.error(checked.error.issues)
}
~~~

For the package boundary, create a local facade and a class backed by the same
native schema. `Schema.decodeUnknown` validates `unknown` and returns a real
class instance or a `better-result` error:

~~~ts
const local = Schema.with(ZodAdapter)

class User extends local.Class<User>('app/User')(UserSchema) {}

const decoded = Schema.decodeUnknown(User, input)
if (Result.isError(decoded)) {
  console.error(decoded.error._tag) // SchemaDecodeFailure
  console.error(decoded.error.issues) // normalized issues with paths
  throw decoded.error
}

const user: User = decoded.value
console.log(user.displayName)
~~~

Use `Schema.decode` instead when the value already has the schema's encoded
input type. Both overloads can be curried:

~~~ts
const decoded = Schema.decode(User)(input)
~~~

The package does not throw expected validation failures. At an imperative
boundary inspect `Result.isError`; inside a `better-effect` generator, yield
the returned value to short-circuit on failure.

## Codecs for transport values

Use a Zod codec when the wire value and application value differ. The adapter
recognizes the codec and `Schema.encode` uses its explicit reverse operation:

~~~ts
const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class Event extends local.Class<Event>('app/Event')({
  id: z.string(),
  occurredAt: DateFromISOString
}) {}

const event = Schema.decode(Event, {
  id: 'event-1',
  occurredAt: '2026-09-06T00:00:00.000Z'
})
if (Result.isError(event)) throw event.error

const wire = Schema.encode(Event, event.value)
if (Result.isError(wire)) throw wire.error
// wire.value.occurredAt is an ISO string
~~~

Read-only schemas do not receive an invented encoder. Use `Schema.encodeAsync`
for an async codec; the synchronous call returns `SchemaAsyncRequired` instead
of invoking an async operation twice.

## Provider-owned capabilities

The local facade exposes Zod-specific class factories and structural
derivations while preserving native Zod behavior:

~~~ts
class Admin extends User.extend<Admin>('app/Admin')({
  role: z.literal('admin')
}) {}

class PartialUser extends User.partial<PartialUser>('app/PartialUser') {}

class PublicUser extends User.pick<PublicUser>('app/PublicUser')({
  id: true,
  displayName: true
}) {}
~~~

Use the provider-native schema directly when you only need Zod. Use
`Schema.decodeUnknown` or the local facade when you want normalized package
failures, class construction, or shared code that can work with another
provider.

## Further reading

- [Zod documentation](https://zod.dev/)
- [Provider-neutral API reference](api.md)
- [Valibot adapter](valibot.md)
- [ArkType adapter](arktype.md)

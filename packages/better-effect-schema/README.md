# better-effect-schema

Provider-neutral schema classes and Result-backed operations for
`better-effect` applications.

The root entrypoint depends only on Standard Schema, `better-result`, and
`better-effect` types. Zod, Valibot, and ArkType are optional peers mounted by
their own subpaths:

```text
better-effect-schema       Standard Schema core
better-effect-schema/zod   Zod 4 adapter and class derivations
better-effect-schema/valibot
better-effect-schema/arktype
```

## Quick start

`Schema.Class` consumes an explicit Standard Schema definition. The class
constructor is for already decoded props; boundary operations return
`better-result` values and never throw expected validation failures.

```ts
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'

const userFields: StandardSchemaV1<{ id: string }, { id: string }> = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate(value) {
      return typeof value === 'object' && value !== null &&
        typeof (value as { id?: unknown }).id === 'string'
        ? { value: value as { id: string } }
        : { issues: [{ message: 'Expected a user' }] }
    }
  }
}

class User extends Schema.Class<User>('example/User')({
  schema: userFields,
  propsSchema: userFields,
  encodedSchema: userFields,
  encode: (value) => value
}) {}

const decoded = Schema.decodeUnknown(User, { id: 'user-1' })
if (Result.isError(decoded)) throw decoded.error
const user = decoded.value
```

`Schema.decode` preserves the encoded input type. `Schema.make` validates
decoded constructor props, and `Schema.encode` requires an explicit encoder.
Use `yield*` with these values in an `Effect.gen` workflow:

```ts
import { Effect } from 'better-effect'
import { Result } from 'better-result'

const workflow = Effect.gen(function* () {
  const value = yield* Schema.decode(User)({ id: 'user-1' })
  const encoded = yield* Schema.encode(User)(value)
  return Result.ok(encoded)
})
```

## Optional provider adapters

Provider packages are imported only by their subpath. This keeps the root
package free of Zod, Valibot, and ArkType runtime code.

```ts
import * as z from 'zod'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'

const Local = Schema.with(ZodAdapter)
const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class Person extends Local.Class<Person>('example/Person')({
  id: z.int().positive(),
  name: z.string(),
  bornAt: DateFromISOString
}) {}

const result = Schema.decode(Person, {
  id: 1,
  name: 'Ada',
  bornAt: '1990-12-10T00:00:00.000Z'
})
if (Result.isError(result)) throw result.error

const wire = Schema.encode(Person, result.value)
if (Result.isError(wire)) throw wire.error
```

Zod-specific class factories and derivations belong to `ZodAdapter`. The
portable `Schema.Class` API is still available for applications that do not
want a provider dependency. See [the Zod adapter guide](docs/zod.md),
[the ArkType guide](docs/arktype.md), and the [Valibot guide](docs/valibot.md).

## Tagged classes and errors

Tagged factories use Standard Schema fields and inject a protected literal
`_tag`. Tagged errors are also `Error` instances and use the
`better-result.TaggedError` protocol, so they can be yielded from
`Result.gen`.

```ts
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'

const stringSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate: (value) => typeof value === 'string'
      ? { value }
      : { issues: [{ message: 'Expected a string' }] }
  }
}

class UserNotFound extends Schema.TaggedError<UserNotFound>()('UserNotFound', {
  userId: stringSchema
}) {}

const failure = UserNotFound.make({ userId: 'user-1' })
if (Result.isError(failure)) throw failure.error
if (!failure.value.message.includes(failure.value.userId)) throw new Error('unreachable')
```

## Public operations

All synchronous operations are requirement-free `Effect<Value, Failure, never>`
values backed by `better-result`.

| Operation | Input | Result |
| --- | --- | --- |
| `Schema.decodeUnknown` | `unknown` | decoded class or `SchemaDecodeFailure` |
| `Schema.decode` | encoded input | decoded class or decode failure |
| `Schema.make` | decoded props | class or `SchemaConstructionFailure` |
| `Schema.encode` | class instance plus explicit encoder | encoded value or encode/unsupported failure |
| `Schema.with(adapter)` | provider schema | adapter-owned capabilities |

Async validators and encoders must use the corresponding `Async` operation.
The sync boundary returns `SchemaAsyncRequired` and does not invoke an async
operation twice. Unexpected provider failures become
`SchemaExecutionFailure`.

## Package boundaries

The package exports the root facade plus `./zod`, `./valibot`, `./arktype`, and
`./package.json`. Adapter packages are optional peers. No provider shim or
legacy root alias is published, and the core source does not import Zod.

Run the package checks with Bun:

```bash
bun run typecheck
bun run test:runtime
bun run test:types
bun run examples
bun run check
```

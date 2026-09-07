# Zod adapter

`better-effect-schema/zod` is the optional Zod 4.5 adapter. Importing the
root package alone does not load Zod.

```ts
import * as z from 'zod'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'

const Local = Schema.with(ZodAdapter)

class User extends Local.Class<User>('app/User')({
  id: z.uuid(),
  name: z.string()
}) {}

const user = Schema.decode(User, { id: '550e8400-e29b-41d4-a716-446655440000', name: 'Ada' })
if (Result.isError(user)) throw user.error
```

The adapter supports Zod object shapes, object schemas, codecs, object
policies, and provider-owned derivations such as `extend`, `pick`, `omit`,
`partial`, `required`, and `deepPartial`. Derived classes preserve their
JavaScript parent identity.

Use a Zod codec when decoded values differ from their transport form:

```ts
const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class Event extends Local.Class<Event>('app/Event')({
  occurredAt: DateFromISOString
}) {}

const decoded = Schema.decode(Event, { occurredAt: '2026-09-06T00:00:00.000Z' })
if (Result.isError(decoded)) throw decoded.error
const encoded = Schema.encode(Event, decoded.value)
if (Result.isError(encoded)) throw encoded.error
```

Native Zod schemas remain available to code that explicitly imports Zod. The
better-effect-schema boundary itself uses `Schema.decode`, `Schema.make`, and
`Schema.encode` so validation failures stay in `Result`.

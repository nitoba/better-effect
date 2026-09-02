import * as z from "zod"
import type { Effect } from "better-effect"
import { Result } from "better-result"

import {
  Schema,
  type Encoded,
  type Props,
  SchemaDecodeFailure,
  SchemaEncodeFailure
} from "../src/index.js"
import type { Equal, Expect } from "./helpers.js"

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class User extends Schema.Class<User>("@type/OperationsUser")({
  id: z.uuid(),
  createdAt: DateFromISOString
}) {}

const decoded = Schema.decodeUnknown(User)({
  id: "550e8400-e29b-41d4-a716-446655440000",
  createdAt: "2026-09-02T10:00:00.000Z"
})
decoded satisfies Effect<User, SchemaDecodeFailure, never>

const encoded = Schema.encode(User)(
  new User({
    id: "550e8400-e29b-41d4-a716-446655440000",
    createdAt: new Date()
  })
)
encoded satisfies Effect<Encoded<typeof User>, SchemaEncodeFailure, never>

Result.gen(function* () {
  const user = yield* decoded
  const wire = yield* Schema.encode(User)(user)
  return Result.ok(wire)
})

type _Props = Expect<Equal<
  Props<typeof User>,
  { readonly id: string; readonly createdAt: Date }
>>
type _Encoded = Expect<Equal<
  Encoded<typeof User>,
  { readonly id: string; readonly createdAt: string }
>>

// @ts-expect-error typed decode does not accept decoded props
Schema.decode(User)({ id: "id", createdAt: new Date() })

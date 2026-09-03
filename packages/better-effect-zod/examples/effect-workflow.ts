import * as z from "zod"
import { Effect } from "better-effect"
import { Result } from "better-result"
import {
  Schema,
  SchemaDecodeFailure,
  SchemaEncodeFailure
} from "better-effect-zod"

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class User extends Schema.Class<User>("examples/EffectUser")({
  id: z.uuid(),
  createdAt: DateFromISOString
}) {}

const input: unknown = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  createdAt: "2026-09-02T10:00:00.000Z"
}

const decoded = Schema.decodeUnknown(User)(input)
decoded satisfies Effect<User, SchemaDecodeFailure, never>

const roundTrip = Effect.gen(function* () {
  const user = yield* decoded
  const encoded = yield* Schema.encode(User)(user)
  return Result.ok(encoded)
})

roundTrip satisfies Effect<
  Schema.Encoded<typeof User>,
  SchemaDecodeFailure | SchemaEncodeFailure,
  never
>

if (roundTrip.status === "error") throw roundTrip.error
if (typeof roundTrip.value.createdAt !== "string") {
  throw new Error("Expected encoded date")
}

console.log("effect-workflow: ok")

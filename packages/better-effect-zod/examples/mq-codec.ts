import * as z from "zod"
import { Result } from "better-result"
import { Schema } from "better-effect-zod"

class UserEvent extends Schema.TaggedClass<UserEvent>()(
  "UserEvent",
  {
    userId: z.uuid(),
    occurredAt: z.codec(z.iso.datetime(), z.date(), {
      decode: (value) => new Date(value),
      encode: (value) => value.toISOString()
    })
  }
) {}

// This is the same explicit pair used by a portable MQ codec adapter:
// unknown persisted JSON -> schema class, then class -> encoded JSON.
const decodePayload = Schema.decodeUnknown(UserEvent)
const encodePayload = Schema.encode(UserEvent)

const decoded = decodePayload({
  _tag: "UserEvent",
  userId: "550e8400-e29b-41d4-a716-446655440000",
  occurredAt: "2026-09-02T10:00:00.000Z"
})

if (Result.isError(decoded)) throw decoded.error
const encoded = encodePayload(decoded.value)
if (Result.isError(encoded)) throw encoded.error
if (typeof encoded.value.occurredAt !== "string") {
  throw new Error("Expected JSON-oriented encoded payload")
}

console.log("mq-codec: ok")

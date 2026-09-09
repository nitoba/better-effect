import * as z from "zod"
import { Result } from "better-result"
import { Schema as CoreSchema } from "better-effect-schema"
import { Schema } from "better-effect-schema/zod"

const UserCodec = z.codec(
  z.object({
    user_id: z.uuid(),
    display_name: z.string(),
    created_at: z.iso.datetime()
  }),
  z.object({
    id: z.uuid(),
    displayName: z.string(),
    createdAt: z.date()
  }),
  {
    decode: (wire) => ({
      id: wire.user_id,
      displayName: wire.display_name,
      createdAt: new Date(wire.created_at)
    }),
    encode: (props) => ({
      user_id: props.id,
      display_name: props.displayName,
      created_at: props.createdAt.toISOString()
    })
  }
)

class User extends Schema.Class<User>("ExampleUser")(UserCodec) {}

const wire = {
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  display_name: "Ada",
  created_at: "2026-09-01T20:00:00.000Z"
}

const decoded = Schema.decode(User, wire)
if (Result.isError(decoded)) throw decoded.error
const user = decoded.value
if (!(user instanceof User)) throw new Error("Expected User instance")
const constructed = User.make({ id: user.id, displayName: user.displayName, createdAt: user.createdAt })
if (Result.isError(constructed)) throw constructed.error
const encoded = CoreSchema.decodeUnknown(User.encodedSchema, wire)
if (Result.isError(encoded) || encoded.value.display_name !== "Ada") throw new Error("Encoded projection failed")
const props = CoreSchema.decodeUnknown(User.propsSchema, { id: user.id, displayName: user.displayName, createdAt: user.createdAt })
if (Result.isError(props) || !(props.value.createdAt instanceof Date)) throw new Error("Props projection failed")

console.log("effect-projections: ok")

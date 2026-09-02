import * as z from "zod"
import { Schema } from "better-effect-zod"

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

const user = User.parse(wire)
if (!(user instanceof User)) throw new Error("Expected User instance")
if (!User.safeMake({ id: user.id, displayName: user.displayName, createdAt: user.createdAt }).success) {
  throw new Error("Expected safeMake success")
}
if (User.encodedSchema.parse(wire).display_name !== "Ada") throw new Error("Encoded projection failed")
if (!(User.propsSchema.parse({ id: user.id, displayName: user.displayName, createdAt: user.createdAt }).createdAt instanceof Date)) {
  throw new Error("Props projection failed")
}

console.log("effect-projections: ok")

import * as z from "zod"
import { Result } from "better-result"
import { Schema } from "better-effect-zod"

const UserRowCodec = z.codec(
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
    decode: (row) => ({
      id: row.user_id,
      displayName: row.display_name,
      createdAt: new Date(row.created_at)
    }),
    encode: (user) => ({
      user_id: user.id,
      display_name: user.displayName,
      created_at: user.createdAt.toISOString()
    })
  }
)

class User extends Schema.Class<User>("examples/KyselyUser")(UserRowCodec) {}

// A real application obtains this unknown row after the Kysely terminal runs.
const queryRow: unknown = {
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  display_name: "Ada",
  created_at: "2026-09-02T10:00:00.000Z"
}

const result = Schema.decodeUnknown(User)(queryRow)
if (Result.isError(result)) throw result.error
if (!(result.value instanceof User)) throw new Error("Expected User instance")

console.log("kysely-row: ok")

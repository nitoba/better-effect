import * as z from "zod"
import type { Effect } from "better-effect"

import {
  Schema,
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaEncodeFailure,
  type SchemaIssue
} from "../src/index.js"

class User extends Schema.Class<User>("@type/User")({
  id: z.uuid(),
  name: z.string()
}) {}

Schema.decodeUnknown(User)({}) satisfies Effect<User, SchemaDecodeFailure, never>
Schema.decode(User)({ id: "id", name: "Ada" }) satisfies Effect<
  User,
  SchemaDecodeFailure,
  never
>
Schema.encode(User)(new User({ id: "id", name: "Ada" })) satisfies Effect<
  { readonly id: string; readonly name: string },
  SchemaEncodeFailure,
  never
>
Schema.make(User)({ id: "id", name: "Ada" }) satisfies Effect<
  User,
  SchemaConstructionFailure,
  never
>

const issue: SchemaIssue = {
  message: "Validation failed",
  path: ["user", 0]
}
issue.message satisfies string

import * as z from "zod"
import type { AnyTaggedError } from "better-result"

import { Z } from "../src/index.js"
import type { Equal, Expect } from "./helpers.js"

class UserCreated extends Z.TaggedClass<UserCreated>()(
  "UserCreated",
  {
    userId: z.uuid()
  }
) {
  get summary(): string {
    return `created:${this.userId}`
  }
}

new UserCreated({ userId: "550e8400-e29b-41d4-a716-446655440000" })
new UserCreated({
  // @ts-expect-error the tag is injected and cannot be supplied to the constructor
  _tag: "UserCreated",
  userId: "550e8400-e29b-41d4-a716-446655440000"
})

const event = UserCreated.parse({
  _tag: "UserCreated",
  userId: "550e8400-e29b-41d4-a716-446655440000"
})
event.summary satisfies string
event._tag satisfies "UserCreated"

type _Props = Expect<Equal<
  Z.Props<typeof UserCreated>,
  { readonly userId: string }
>>
type _Encoded = Expect<Equal<
  Z.Encoded<typeof UserCreated>,
  { readonly _tag: "UserCreated"; readonly userId: string }
>>

class UserNotFound extends Z.TaggedError<UserNotFound>()(
  "UserNotFound",
  {
    userId: z.uuid()
  }
) {
  override get message(): string {
    return `User ${this.userId} was not found`
  }
}

const error = new UserNotFound({
  userId: "550e8400-e29b-41d4-a716-446655440000"
})
error.stack satisfies string | undefined
error.message satisfies string
error._tag satisfies "UserNotFound"
error satisfies AnyTaggedError
error.match({ UserNotFound: (failure) => failure.userId }) satisfies string
error[Symbol.iterator]()

class UserCreatedSummary extends UserCreated.pick<UserCreatedSummary>(
  "UserCreatedSummary"
)({ userId: true }) {}

new UserCreatedSummary({
  userId: "550e8400-e29b-41d4-a716-446655440000"
})
// @ts-expect-error protected tag is not a legal pick-mask key
UserCreated.pick<UserCreatedSummary>("Broken")({ _tag: true })
// @ts-expect-error protected tag cannot be overwritten by extension
UserCreated.extend<UserCreatedSummary>("Broken")({ _tag: z.literal("Other") })

Z.TaggedError<UserNotFound>()("ValidError", { reason: z.string() })
Z.TaggedError<UserNotFound>()("InvalidErrorName", {
  // @ts-expect-error Error.name is reserved by TaggedError
  name: z.string()
})
Z.TaggedError<UserNotFound>()("InvalidErrorStack", {
  // @ts-expect-error Error.stack is reserved by TaggedError
  stack: z.string()
})

Z.TaggedError<UserNotFound>()("InvalidErrorMatch", {
  // @ts-expect-error match is reserved by better-result TaggedError
  match: z.string()
})
Z.TaggedError<UserNotFound>()("InvalidErrorToJSON", {
  // @ts-expect-error toJSON is reserved by better-result TaggedError
  toJSON: z.string()
})

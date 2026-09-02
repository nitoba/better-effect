import * as z from "zod"
import { Result, TaggedError } from "better-result"
import { Schema } from "better-effect-zod"

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) throw new Error(message)
}

class UserCreated extends Schema.TaggedClass<UserCreated>()(
  "UserCreated",
  { userId: z.uuid() }
) {}

class UserDeleted extends Schema.TaggedClass<UserDeleted>()(
  "UserDeleted",
  { userId: z.uuid() }
) {}

const UserEvent = z.union([UserCreated, UserDeleted])
const event = UserEvent.parse({
  _tag: "UserCreated",
  userId: "550e8400-e29b-41d4-a716-446655440000"
})

assert(event instanceof UserCreated, "union must preserve concrete class")
assert(event._tag === "UserCreated", "tag must be decoded")

class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { userId: z.uuid() }
) {
  override get message(): string {
    return `User ${this.userId} was not found`
  }
}

const failure = new UserNotFound({
  userId: "550e8400-e29b-41d4-a716-446655440000"
})

assert(failure instanceof Error, "TaggedError must be an Error")
assert(failure._tag === "UserNotFound", "TaggedError must inject its tag")
assert(failure.message.includes(failure.userId), "custom message must work")
assert(TaggedError.is(failure), "must use the better-result error protocol")
assert(
  failure.match({ UserNotFound: (error) => error.userId }) === failure.userId,
  "instance matching must work"
)

const shortCircuited = Result.gen(function* () {
  yield* failure
  return Result.ok("unreachable")
})
assert(Result.isError(shortCircuited), "yielding the error must short-circuit")

console.log("tagged-errors: ok")

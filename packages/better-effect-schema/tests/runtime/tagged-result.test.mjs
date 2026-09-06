import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"
import {
  Result,
  TaggedError as BetterResultTaggedError,
  isTaggedError
} from "better-result"

import { Schema } from "../../dist/esm/index.js"

class UserNotFound extends Schema.TaggedError()(
  "UserNotFound",
  { userId: z.uuid() }
) {
  get message() {
    return `User ${this.userId} was not found`
  }
}

test("schema tagged errors use the better-result runtime protocol", () => {
  const error = new UserNotFound({
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })

  assert.ok(error instanceof Error)
  assert.ok(error instanceof UserNotFound)
  assert.equal(UserNotFound.is(error), true)
  assert.equal(BetterResultTaggedError.is(error), true)
  assert.equal(isTaggedError(error), true)
  assert.equal(typeof error.match, "function")
  assert.equal(typeof error[Symbol.iterator], "function")
})

test("schema tagged errors short-circuit Result.gen by identity", () => {
  const error = new UserNotFound({
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })

  const result = Result.gen(function* () {
    yield* error
    return Result.ok("unreachable")
  })

  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.strictEqual(result.error, error)
})

test("schema tagged errors support exhaustive instance matching", () => {
  const error = new UserNotFound({
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })

  const message = error.match({
    UserNotFound: (failure) => failure.message
  })

  assert.equal(message, error.message)
})

test("decoded tagged errors retain matching and yieldability", () => {
  const error = UserNotFound.parse({
    _tag: "UserNotFound",
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })

  assert.equal(BetterResultTaggedError.is(error), true)
  assert.equal(error.match({ UserNotFound: () => "matched" }), "matched")
  assert.deepEqual(UserNotFound.encode(error), {
    _tag: "UserNotFound",
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })
})

import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"

import { Schema, Z, ZodClassError } from "../../dist/esm/index.js"

class UserCreated extends Z.TaggedClass()(
  "UserCreated",
  {
    userId: z.uuid()
  }
) {
  get summary() {
    return `created:${this.userId}`
  }
}

class UserDeleted extends Z.TaggedClass()(
  "UserDeleted",
  {
    userId: z.uuid()
  }
) {}

test("TaggedClass injects its tag during construction", () => {
  const event = new UserCreated({
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })

  assert.equal(event._tag, "UserCreated")
  assert.equal(event.summary, "created:550e8400-e29b-41d4-a716-446655440000")
  assert.deepEqual(UserCreated.encode(event), {
    _tag: "UserCreated",
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })
})

test("TaggedClass decodes discriminated values and rejects a wrong tag", () => {
  const event = UserCreated.parse({
    _tag: "UserCreated",
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })

  assert.ok(event instanceof UserCreated)
  assert.throws(
    () => UserCreated.parse({
      _tag: "UserDeleted",
      userId: "550e8400-e29b-41d4-a716-446655440000"
    }),
    z.ZodError
  )
  assert.throws(
    () => new UserCreated({
      _tag: "UserDeleted",
      userId: "550e8400-e29b-41d4-a716-446655440000"
    }),
    (error) => error instanceof ZodClassError && error.code === "INVALID_TAG"
  )
})

test("tagged classes compose in unions", () => {
  const Event = z.union([UserCreated, UserDeleted])
  const deleted = Event.parse({
    _tag: "UserDeleted",
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })

  assert.ok(deleted instanceof UserDeleted)
})

test("tagged derivations preserve and protect the tag", () => {
  class UserCreatedSummary extends UserCreated.pick("UserCreatedSummary")({
    userId: true
  }) {}
  class OptionalUserCreated extends UserCreated.partial("OptionalUserCreated") {}

  const summary = UserCreatedSummary.parse({
    _tag: "UserCreated",
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })
  const optional = new OptionalUserCreated()

  assert.equal(summary._tag, "UserCreated")
  assert.deepEqual(UserCreatedSummary.encode(summary), {
    _tag: "UserCreated",
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })
  assert.deepEqual(OptionalUserCreated.encode(optional), {
    _tag: "UserCreated"
  })
  assert.throws(
    () => UserCreated.omit("Broken")({ _tag: true }),
    (error) => error instanceof ZodClassError && error.code === "INVALID_TAG"
  )
  assert.throws(
    () => UserCreated.extend("Broken")({ _tag: z.literal("Other") }),
    (error) => error instanceof ZodClassError && error.code === "INVALID_TAG"
  )
})

class UserNotFound extends Z.TaggedError()(
  "UserNotFound",
  {
    userId: z.uuid()
  }
) {
  get message() {
    return `User ${this.userId} was not found`
  }
}

test("TaggedError is a real Error and remains a bidirectional schema", () => {
  const error = new UserNotFound({
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })

  assert.ok(error instanceof Error)
  assert.ok(error instanceof UserNotFound)
  assert.equal(error.name, "UserNotFound")
  assert.equal(error._tag, "UserNotFound")
  assert.equal(
    error.message,
    "User 550e8400-e29b-41d4-a716-446655440000 was not found"
  )
  assert.equal(typeof error.stack, "string")

  const decoded = UserNotFound.parse({
    _tag: "UserNotFound",
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })

  assert.ok(decoded instanceof Error)
  assert.deepEqual(UserNotFound.encode(decoded), {
    _tag: "UserNotFound",
    userId: "550e8400-e29b-41d4-a716-446655440000"
  })
})

test("required derivations keep the protected tag as a literal schema", () => {
  class OptionalUserCreated extends UserCreated.partial("OptionalBeforeRequired") {}
  class RequiredUserCreated extends OptionalUserCreated.required("RequiredAfterOptional") {}

  assert.ok(RequiredUserCreated.fields._tag instanceof z.ZodLiteral)
  assert.equal(RequiredUserCreated.fields._tag.value, "UserCreated")
})

test("TaggedError rejects fields reserved by native Error instances", () => {
  for (const reserved of ["name", "stack", "match", "toJSON"]) {
    assert.throws(
      () => Z.TaggedError()(`Invalid${reserved}`, { [reserved]: z.string() }),
      (error) => error instanceof ZodClassError && error.code === "INVALID_TAG"
    )
  }
})


test("Schema is the preferred facade while Z remains an alias", () => {
  assert.strictEqual(Schema.Class, Z.Class)
  assert.strictEqual(Schema.TaggedError, Z.TaggedError)
})

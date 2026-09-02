import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"
import { Result } from "better-result"

import {
  Schema,
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaEncodeFailure
} from "../../dist/esm/index.js"

class User extends Schema.Class("@test/User")({
  id: z.uuid(),
  name: z.string().min(1)
}) {}

const expectFailure = (result, Failure, tag) => {
  assert.equal(Result.isError(result), true)
  if (!Result.isError(result)) return

  assert.ok(result.error instanceof Failure)
  assert.equal(result.error._tag, tag)
  assert.equal(result.error.identifier, "@test/User")
  assert.equal(Object.prototype.propertyIsEnumerable.call(result.error, "cause"), false)
  assert.ok(result.error.cause instanceof z.ZodError)
  assert.ok(Object.isFrozen(result.error.issues))
  assert.ok(result.error.issues.length > 0)

  const json = result.error.toJSON()
  assert.equal(json._tag, tag)
  assert.equal(json.identifier, "@test/User")
  assert.equal("cause" in json, false)
  assert.equal("stack" in json, false)
  assert.equal(JSON.stringify(json).includes("secret-value"), false)
}

test("decode failures are tagged, yieldable, and safely serialized", () => {
  const result = Schema.decodeUnknown(User)({
    id: "secret-value",
    name: ""
  })

  expectFailure(result, SchemaDecodeFailure, "SchemaDecodeFailure")
})

test("encode failures are tagged and omit the rejected value", () => {
  const result = Schema.encode(User)({
    id: "secret-value",
    name: "Ada"
  })

  expectFailure(result, SchemaEncodeFailure, "SchemaEncodeFailure")
})

test("construction failures use a distinct error channel", () => {
  const result = Schema.make(User)({
    id: "secret-value",
    name: ""
  })

  expectFailure(result, SchemaConstructionFailure, "SchemaConstructionFailure")
})

test("issue normalization bounds count, path, code, and messages", () => {
  const Many = z.object(Object.fromEntries(
    Array.from({ length: 48 }, (_, index) => [`field${index}`, z.string()])
  ))

  const result = Schema.decodeUnknown(Many)({})
  assert.equal(Result.isError(result), true)
  if (!Result.isError(result)) return

  assert.ok(result.error.issues.length <= 32)
  for (const issue of result.error.issues) {
    assert.equal(issue.message, "Validation failed")
    assert.ok(issue.code === undefined || issue.code.length <= 64)
    assert.ok(issue.path === undefined || issue.path.length <= 64)
  }
})

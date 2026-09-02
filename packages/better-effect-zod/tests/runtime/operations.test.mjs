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

const DateFromISOString = z.codec(
  z.iso.datetime(),
  z.date(),
  {
    decode: (value) => new Date(value),
    encode: (value) => value.toISOString()
  }
)

class User extends Schema.Class("@test/OperationsUser")({
  id: z.uuid(),
  createdAt: DateFromISOString
}) {}

const encoded = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  createdAt: "2026-09-02T10:00:00.000Z"
}

test("decodeUnknown supports data-last and data-first forms", () => {
  const curried = Schema.decodeUnknown(User)(encoded)
  const direct = Schema.decodeUnknown(User, encoded)

  for (const result of [curried, direct]) {
    assert.equal(Result.isOk(result), true)
    if (Result.isOk(result)) {
      assert.ok(result.value instanceof User)
      assert.ok(result.value.createdAt instanceof Date)
    }
  }
})

test("decode preserves the encoded input type at the API boundary", () => {
  const result = Schema.decode(User)(encoded)
  assert.equal(Result.isOk(result), true)
})

test("encode supports data-last and data-first forms", () => {
  const user = new User({ id: encoded.id, createdAt: new Date(encoded.createdAt) })
  const curried = Schema.encode(User)(user)
  const direct = Schema.encode(User, user)

  for (const result of [curried, direct]) {
    assert.equal(Result.isOk(result), true)
    if (Result.isOk(result)) assert.deepEqual(result.value, encoded)
  }
})

test("make returns validated class instances without throwing expected failures", () => {
  const good = Schema.make(User)({
    id: encoded.id,
    createdAt: new Date(encoded.createdAt)
  })
  const bad = Schema.make(User)({
    id: "invalid",
    createdAt: new Date(encoded.createdAt)
  })

  assert.equal(Result.isOk(good), true)
  if (Result.isOk(good)) assert.ok(good.value instanceof User)
  assert.equal(Result.isError(bad), true)
  if (Result.isError(bad)) assert.ok(bad.error instanceof SchemaConstructionFailure)
})

test("schema operations compose directly in Result.gen", () => {
  const result = Result.gen(function* () {
    const user = yield* Schema.decodeUnknown(User)(encoded)
    const roundTrip = yield* Schema.encode(User)(user)
    return Result.ok(roundTrip)
  })

  assert.equal(Result.isOk(result), true)
  if (Result.isOk(result)) assert.deepEqual(result.value, encoded)
})

test("async operations support async Zod refinements", async () => {
  const AsyncSchema = z.string().superRefine(async (value, context) => {
    await Promise.resolve()
    if (value === "taken") {
      context.addIssue({ code: "custom", message: "secret-value" })
    }
  })

  const good = await Schema.decodeUnknownAsync(AsyncSchema)("free")
  const bad = await Schema.decodeUnknownAsync(AsyncSchema, "taken")

  assert.equal(Result.isOk(good), true)
  assert.equal(Result.isError(bad), true)
  if (Result.isError(bad)) assert.ok(bad.error instanceof SchemaDecodeFailure)
})

test("encode and decode failures remain distinct", () => {
  const decodeFailure = Schema.decodeUnknown(User)({})
  const encodeFailure = Schema.encode(User)({})

  assert.equal(Result.isError(decodeFailure), true)
  assert.equal(Result.isError(encodeFailure), true)
  if (Result.isError(decodeFailure)) assert.ok(decodeFailure.error instanceof SchemaDecodeFailure)
  if (Result.isError(encodeFailure)) assert.ok(encodeFailure.error instanceof SchemaEncodeFailure)
})

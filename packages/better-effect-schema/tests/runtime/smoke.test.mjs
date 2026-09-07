import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"

import { isSchemaClass, Z } from "../../dist/esm/index.js"

test("exports the class API", () => {
  assert.equal(typeof Z.Class, "function")
  assert.equal(typeof Z.TaggedClass, "function")
  assert.equal(typeof Z.TaggedError, "function")
  assert.equal(typeof Z.isSchemaClass, "function")

  class Example extends Z.Class("SmokeExample")({}) {}

  assert.equal(isSchemaClass(Example), true)
  assert.equal(Z.isSchemaClass(Example), true)
  assert.equal(Z.isSchemaClass(z.object({})), false)
})

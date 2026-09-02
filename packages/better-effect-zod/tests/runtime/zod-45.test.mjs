import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"

import { Z } from "../../dist/esm/index.js"

const compileAvailable = typeof z.compile === "function"
const validateAvailable = typeof z.validate === "function"

const SYMBOL_FIELD = Symbol("better-effect-zod/symbol-field")

const symbolFieldsAvailable = (() => {
  try {
    const probe = z.object({ [SYMBOL_FIELD]: z.string() })
    const parsed = probe.parse({ [SYMBOL_FIELD]: "ok" })
    return Reflect.get(parsed, SYMBOL_FIELD) === "ok"
  } catch {
    return false
  }
})()

test("Zod 4.5 compile accepts a schema-class facade", {
  skip: compileAvailable
    ? false
    : "The installed compatibility harness does not expose z.compile."
}, () => {
  class CompiledPerson extends Z.Class("Zod45CompiledPerson")({
    id: z.int(),
    name: z.string()
  }) {}

  const CompiledSchema = z.compile(CompiledPerson)
  const person = CompiledSchema.parse({ id: 1, name: "Ada" })

  assert.ok(person instanceof CompiledPerson)
  assert.deepEqual(CompiledSchema.encode(person), { id: 1, name: "Ada" })
})

test("Zod 4.5 validate accepts a schema-class facade", {
  skip: validateAvailable
    ? false
    : "The installed compatibility harness does not expose z.validate."
}, () => {
  class ValidatedPerson extends Z.Class("Zod45ValidatedPerson")({
    id: z.int().positive(),
    name: z.string().min(1)
  }) {}

  assert.equal(z.validate(ValidatedPerson, { id: 1, name: "Ada" }), true)
  assert.equal(z.validate(ValidatedPerson, { id: 0, name: "" }), false)
})

test("Zod 4.5 symbol-key fields survive decode and encode", {
  skip: symbolFieldsAvailable
    ? false
    : "The installed compatibility harness does not expose symbol-key object fields."
}, () => {
  class SymbolRecord extends Z.Class("Zod45SymbolRecord")({
    [SYMBOL_FIELD]: z.string(),
    name: z.string()
  }) {}

  const decoded = SymbolRecord.parse({
    [SYMBOL_FIELD]: "private-value",
    name: "Ada"
  })

  assert.equal(decoded[SYMBOL_FIELD], "private-value")
  assert.ok(Reflect.ownKeys(decoded).includes(SYMBOL_FIELD))

  const encoded = SymbolRecord.encode(decoded)
  assert.equal(encoded[SYMBOL_FIELD], "private-value")
  assert.ok(Reflect.ownKeys(encoded).includes(SYMBOL_FIELD))
})

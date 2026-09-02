import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"

import { Z } from "../../dist/esm/index.js"

class Person extends Z.Class("ObjectModePerson")({
  id: z.int(),
  name: z.string()
}) {}

test("strict derives a class that rejects unknown properties", () => {
  class StrictPerson extends Person.strict("StrictPerson") {}

  assert.throws(
    () => StrictPerson.parse({ id: 1, name: "Ada", extra: true }),
    z.ZodError
  )
})

test("loose derives a class that preserves unknown properties", () => {
  class LoosePerson extends Person.loose("LoosePerson") {}

  const person = LoosePerson.parse({ id: 1, name: "Ada", extra: true })

  assert.equal(person.extra, true)
  assert.deepEqual(LoosePerson.encode(person), {
    id: 1,
    name: "Ada",
    extra: true
  })
})

test("strip derives a class that removes unknown properties", () => {
  class LoosePerson extends Person.loose("LooseBeforeStrip") {}
  class StrippedPerson extends LoosePerson.strip("StrippedPerson") {}

  const person = StrippedPerson.parse({ id: 1, name: "Ada", extra: true })

  assert.equal("extra" in person, false)
  assert.deepEqual(StrippedPerson.encode(person), { id: 1, name: "Ada" })
})

test("catchall derives a class that validates unknown properties", () => {
  class MetadataPerson extends Person.catchall("MetadataPerson")(z.string()) {}

  const person = MetadataPerson.parse({ id: 1, name: "Ada", source: "api" })

  assert.equal(person.source, "api")
  assert.throws(
    () => MetadataPerson.parse({ id: 1, name: "Ada", source: 123 }),
    z.ZodError
  )
})

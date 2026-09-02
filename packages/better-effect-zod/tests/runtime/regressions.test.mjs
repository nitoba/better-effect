import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"

import { Z } from "../../dist/esm/index.js"

class Person extends Z.Class("RegressionPerson")({
  id: z.int(),
  name: z.string()
}) {}

test("delegates Zod apply instead of Function.prototype.apply", () => {
  const OptionalPerson = Person.apply((schema) => schema.optional())
  const parsed = OptionalPerson.parse({ id: 1, name: "Ada" })

  assert.ok(parsed instanceof Person)
  assert.equal(OptionalPerson.parse(undefined), undefined)
})

test("exposes the concrete codec and class kind", () => {
  const optional = Person.optional()

  assert.equal(Person.codec, optional.innerType)
  assert.equal(Person.kind, "class")
})

test("recognizes schema class instances without accepting plain objects", () => {
  const person = new Person({ id: 1, name: "Ada" })

  assert.equal(Z.isClassInstance(person), true)
  assert.equal(Z.isClassInstance({ id: 1, name: "Ada" }), false)
  assert.equal(Z.isClassInstance(Person), false)
})

test("default metadata does not reserve a global registry id", () => {
  class First extends Z.Class("ReloadablePerson")({ id: z.int() }) {}
  class Second extends Z.Class("ReloadablePerson")({ id: z.int() }) {}

  assert.deepEqual(First.meta(), { title: "ReloadablePerson" })
  assert.deepEqual(Second.meta(), { title: "ReloadablePerson" })
})

test("runtime identity includes the class kind as well as the identifier", () => {
  class Plain extends Z.Class("SharedIdentifier")({ id: z.int() }) {}
  class Event extends Z.TaggedClass()("SharedIdentifier", { id: z.int() }) {}
  class Failure extends Z.TaggedError()("SharedIdentifier", { id: z.int() }) {}

  const plain = new Plain({ id: 1 })
  const event = new Event({ id: 1 })
  const failure = new Failure({ id: 1 })

  assert.equal(Plain.is(plain), true)
  assert.equal(Plain.is(event), false)
  assert.equal(Plain.is(failure), false)
  assert.equal(Event.is(plain), false)
  assert.equal(Event.is(event), true)
  assert.equal(Event.is(failure), false)
  assert.equal(Failure.is(failure), true)
})

test("explicit registry ids belong to the concrete class, not its generated base", () => {
  class Registered extends Z.Class("RegisteredWithId", {
    id: "urn:better-effect-zod:registered",
    title: "Registered"
  })({ value: z.string() }) {}

  const generatedBase = Object.getPrototypeOf(Registered)

  assert.deepEqual(z.globalRegistry.get(generatedBase), {
    title: "Registered"
  })
  assert.equal(Registered.meta().id, "urn:better-effect-zod:registered")

  const codec = Registered.codec
  assert.equal(z.globalRegistry.get(Registered).id, "urn:better-effect-zod:registered")
  assert.equal(z.globalRegistry.get(codec).id, undefined)
})

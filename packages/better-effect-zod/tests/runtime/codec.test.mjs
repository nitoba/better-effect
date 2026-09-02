import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"

import { Z } from "../../dist/esm/index.js"

const DateFromISOString = z.codec(
  z.iso.datetime(),
  z.date(),
  {
    decode: (value) => new Date(value),
    encode: (value) => value.toISOString()
  }
)

class Person extends Z.Class("Person")({
  id: z.int().positive(),
  name: z.string().min(1),
  bornAt: DateFromISOString
}) {
  get label() {
    return `${this.name} #${this.id}`
  }
}

const encodedAda = {
  id: 1,
  name: "Ada",
  bornAt: "1815-12-10T00:00:00.000Z"
}

test("decodes encoded objects into concrete class instances", () => {
  const person = Person.parse(encodedAda)

  assert.ok(person instanceof Person)
  assert.equal(person.label, "Ada #1")
  assert.ok(person.bornAt instanceof Date)
  assert.equal(person.bornAt.toISOString(), encodedAda.bornAt)
  const decoded = z.decode(Person, encodedAda)
  assert.ok(decoded instanceof Person)
  assert.deepEqual(Person.encode(decoded), encodedAda)
})

test("encodes class instances back to their external representation", () => {
  const person = new Person({
    id: 1,
    name: "Ada",
    bornAt: new Date(encodedAda.bornAt)
  })

  assert.deepEqual(Person.encode(person), encodedAda)
  assert.deepEqual(z.encode(Person, person), encodedAda)
  assert.throws(
    () => Person.encode({ ...person }),
    z.ZodError
  )
})

test("works anywhere a normal Zod schema is accepted", () => {
  const Team = z.object({
    name: z.string(),
    members: z.array(Person)
  })

  const team = Team.parse({
    name: "Computing",
    members: [encodedAda]
  })

  assert.ok(team.members[0] instanceof Person)
  assert.equal(team.members[0].label, "Ada #1")
  assert.deepEqual(Team.encode(team), {
    name: "Computing",
    members: [encodedAda]
  })
})

test("exposes normal Zod combinators through the class", () => {
  const OptionalPerson = Person.optional()
  const People = Person.array()

  assert.equal(OptionalPerson.parse(undefined), undefined)
  assert.ok(OptionalPerson.parse(encodedAda) instanceof Person)
  assert.ok(People.parse([encodedAda])[0] instanceof Person)
})

test("preserves safe parse and async schema behavior", async () => {
  const bad = Person.safeParse({ ...encodedAda, id: 0 })
  assert.equal(bad.success, false)

  const person = await Person.parseAsync(encodedAda)
  assert.ok(person instanceof Person)

  const encoded = await Person.encodeAsync(person)
  assert.deepEqual(encoded, encodedAda)
})

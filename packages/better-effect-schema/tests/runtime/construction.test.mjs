import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"

import { Z, ZodClassError } from "../../dist/esm/index.js"

const makePersonClass = () => class Person extends Z.Class("Person")({
  id: z.int().positive(),
  name: z.string().min(1)
}) {
  get label() {
    return `${this.name} #${this.id}`
  }
}

test("constructs a validated class instance with inherited fields and methods", () => {
  const Person = makePersonClass()
  const person = new Person({ id: 1, name: "Ada" })

  assert.ok(person instanceof Person)
  assert.equal(person.id, 1)
  assert.equal(person.name, "Ada")
  assert.equal(person.label, "Ada #1")
  assert.equal(Person.identifier, "Person")
  assert.equal(Person.fields.id.type, "number")
  assert.equal(Person.struct.type, "object")
  assert.equal(Person.schema, Person)
})

test("validates decoded props in both the constructor and make", () => {
  const Person = makePersonClass()

  assert.throws(() => new Person({ id: 0, name: "" }), z.ZodError)
  assert.throws(() => Person.make({ id: -1, name: "Ada" }), z.ZodError)

  const person = Person.make({ id: 2, name: "Grace" })
  assert.ok(person instanceof Person)
  assert.equal(person.label, "Grace #2")
})

test("unsafeMake bypasses validation explicitly", () => {
  const Person = makePersonClass()
  const person = Person.unsafeMake({ id: -1, name: "" })

  assert.ok(person instanceof Person)
  assert.equal(person.id, -1)
  assert.equal(person.name, "")
})

test("validates decoded props without reconstructing nested class instances", () => {
  class Address extends Z.Class("ConstructionAddress")({
    city: z.string().min(1)
  }) {}

  class Customer extends Z.Class("ConstructionCustomer")({
    name: z.string().min(1),
    address: Address
  }) {}

  const address = new Address({ city: "Fortaleza" })
  const customer = new Customer({ name: "Ada", address })

  assert.strictEqual(customer.address, address)
})

test("applies defaults and object refinements while validating decoded props", () => {
  const AccountStruct = z.object({
    name: z.string().min(1),
    status: z.string().default("active")
  }).superRefine((value, context) => {
    if (value.name === "root" && value.status !== "system") {
      context.addIssue({
        code: "custom",
        message: "The root account must use system status"
      })
    }
  })

  class Account extends Z.Class("ConstructionDefaults")(AccountStruct) {}

  const account = new Account({ name: "Ada" })
  assert.equal(account.status, "active")

  assert.throws(
    () => new Account({ name: "root" }),
    z.ZodError
  )

  const root = new Account({ name: "root", status: "system" })
  assert.equal(root.status, "system")
})

test("supports fieldless classes without an argument", () => {
  class Empty extends Z.Class("Empty")({}) {
    value() {
      return 42
    }
  }

  const empty = new Empty()
  assert.ok(empty instanceof Empty)
  assert.equal(empty.value(), 42)
  assert.deepEqual(Object.keys(empty), [])
})

test("recognizes instances by stable identifier across class re-evaluation", () => {
  const FirstPerson = makePersonClass()
  const oldInstance = new FirstPerson({ id: 1, name: "Ada" })
  const ReloadedPerson = makePersonClass()

  assert.equal(FirstPerson.is(oldInstance), true)
  assert.equal(ReloadedPerson.is(oldInstance), true)
  assert.equal(oldInstance instanceof ReloadedPerson, true)
  assert.equal(ReloadedPerson.is({ id: 1, name: "Ada" }), false)
})

test("rejects blank identifiers with a stable contract error", () => {
  assert.throws(
    () => Z.Class("   ")({ value: z.string() }),
    (error) => error instanceof ZodClassError && error.code === "INVALID_IDENTIFIER"
  )
})

test("rejects arrays and other non-object schema definitions", () => {
  assert.throws(
    () => Z.Class("InvalidDefinition")([]),
    (error) => error instanceof ZodClassError && error.code === "INVALID_DEFINITION"
  )
})

test("validates constructor props from the projected output schema without running codec handlers", () => {
  let decodes = 0
  let encodes = 0

  const EncodedValue = z.codec(
    z.string(),
    z.string().min(3),
    {
      decode(value) {
        decodes += 1
        return value.toUpperCase()
      },
      encode(value) {
        encodes += 1
        return value.toLowerCase()
      }
    }
  )

  class Value extends Z.Class("ProjectedOutputValue")({
    value: EncodedValue
  }) {}

  const instance = new Value({ value: "READY" })

  assert.equal(instance.value, "READY")
  assert.equal(decodes, 0)
  assert.equal(encodes, 0)
  assert.throws(() => new Value({ value: "no" }), z.ZodError)
})

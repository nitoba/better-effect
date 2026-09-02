import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"

import { Z } from "../../dist/esm/index.js"

class Person extends Z.Class("Person")({
  id: z.int().positive(),
  name: z.string().min(1)
}) {
  get label() {
    return `${this.name} #${this.id}`
  }
}

test("extend preserves parent fields, behavior, and schema composition", () => {
  class Employee extends Person.extend("Employee")({
    role: z.enum(["admin", "member"])
  }) {
    canManageUsers() {
      return this.role === "admin"
    }
  }

  const employee = Employee.parse({
    id: 1,
    name: "Ada",
    role: "admin"
  })

  assert.ok(employee instanceof Employee)
  assert.ok(employee instanceof Person)
  assert.equal(employee.label, "Ada #1")
  assert.equal(employee.canManageUsers(), true)
  assert.deepEqual(Object.keys(Employee.fields), ["id", "name", "role"])
  assert.deepEqual(Employee.encode(employee), {
    id: 1,
    name: "Ada",
    role: "admin"
  })
})

test("pick and omit derive focused schema classes", () => {
  class PersonSummary extends Person.pick("PersonSummary")({
    id: true,
    name: true
  }) {}

  class PersonName extends Person.omit("PersonName")({
    id: true
  }) {}

  const summary = PersonSummary.parse({ id: 1, name: "Ada" })
  const name = PersonName.parse({ name: "Grace" })

  assert.ok(summary instanceof PersonSummary)
  assert.equal(summary instanceof Person, true)
  assert.deepEqual(Object.keys(PersonSummary.fields), ["id", "name"])
  assert.deepEqual(PersonSummary.encode(summary), { id: 1, name: "Ada" })
  assert.deepEqual(PersonName.encode(name), { name: "Grace" })
})

test("partial and required derive classes with predictable construction", () => {
  class PersonPatch extends Person.partial("PersonPatch") {}
  class CompletePerson extends PersonPatch.required("CompletePerson") {}

  const emptyPatch = new PersonPatch()
  const namedPatch = PersonPatch.parse({ name: "Ada" })

  assert.deepEqual(PersonPatch.encode(emptyPatch), {})
  assert.equal(namedPatch.name, "Ada")
  assert.throws(() => CompletePerson.parse({ name: "Ada" }), z.ZodError)
  assert.ok(CompletePerson.fields.id instanceof z.ZodNonOptional)

  const complete = CompletePerson.parse({ id: 1, name: "Ada" })
  assert.deepEqual(CompletePerson.encode(complete), { id: 1, name: "Ada" })
})

test("selective partial and required masks only transform selected fields", () => {
  class NameOptional extends Person.partial("NameOptional", { name: true }) {}
  class NameRequired extends NameOptional.required("NameRequired", { name: true }) {}

  assert.ok(NameOptional.parse({ id: 1 }) instanceof NameOptional)
  assert.throws(() => NameOptional.parse({ name: "Ada" }), z.ZodError)
  assert.throws(() => NameRequired.parse({ id: 1 }), z.ZodError)
  assert.ok(NameRequired.parse({ id: 1, name: "Ada" }) instanceof NameRequired)
})

test("empty selective masks are no-ops rather than all-field transforms", () => {
  class UnchangedPerson extends Person.partial("UnchangedPerson", {}) {}
  class StillOptional extends Person.partial("StillOptional") {}
  class UnchangedPatch extends StillOptional.required("UnchangedPatch", {}) {}

  assert.throws(() => UnchangedPerson.parse({}), z.ZodError)
  assert.ok(UnchangedPerson.parse({ id: 1, name: "Ada" }) instanceof UnchangedPerson)
  assert.ok(UnchangedPatch.parse({}) instanceof UnchangedPatch)
})

test("safe extension retains object-level refinements", () => {
  const RefinedPerson = z.object({
    id: z.int(),
    name: z.string()
  }).superRefine((value, context) => {
    if (value.name === "admin" && value.id !== 1) {
      context.addIssue({
        code: "custom",
        message: "Only id 1 can use the admin name"
      })
    }
  })

  class Account extends Z.Class("Account")(RefinedPerson) {}
  class AdminAccount extends Account.extend("AdminAccount")({
    enabled: z.literal(true)
  }) {}

  assert.throws(
    () => AdminAccount.parse({ id: 2, name: "admin", enabled: true }),
    z.ZodError
  )
  assert.ok(
    AdminAccount.parse({ id: 1, name: "admin", enabled: true })
      instanceof AdminAccount
  )
})

test("validates a derived value before running parent constructor effects", () => {
  const constructed = []

  class Base extends Z.Class("ValidatedBeforeSuper")({
    id: z.int()
  }) {
    constructor(props) {
      super(props)
      constructed.push(props.id)
    }
  }

  class Derived extends Base.extend("ValidatedBeforeSuperDerived")({
    role: z.enum(["admin", "member"])
  }) {}

  assert.throws(
    () => new Derived({ id: 1, role: "invalid" }),
    z.ZodError
  )
  assert.deepEqual(constructed, [])

  const valid = new Derived({ id: 2, role: "admin" })
  assert.equal(valid.id, 2)
  assert.deepEqual(constructed, [2])
})

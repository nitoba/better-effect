import * as z from "zod"
import { Schema } from "better-effect-zod"

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) throw new Error(message)
}

class Person extends Schema.Class<Person>("examples/DerivationPerson")({
  id: z.int().positive(),
  name: z.string().min(1)
}) {
  get label(): string {
    return `${this.name} #${this.id}`
  }
}

class Employee extends Person.extend<Employee>(
  "examples/Employee"
)({
  role: z.enum(["admin", "member"])
}) {
  canManageUsers(): boolean {
    return this.role === "admin"
  }
}

class PersonSummary extends Person.pick<PersonSummary>(
  "examples/PersonSummary"
)({
  id: true,
  name: true
}) {}

const employee = Employee.parse({
  id: 1,
  name: "Ada",
  role: "admin"
})

assert(employee instanceof Employee, "decode must create Employee")
assert(employee instanceof Person, "derived class must satisfy parent identity")
assert(employee.label === "Ada #1", "parent getter must remain available")
assert(employee.canManageUsers(), "child method must remain available")

const summary = new PersonSummary({ id: 1, name: "Ada" })
assert(summary.label === "Ada #1", "meaningful inherited getter must work")

console.log("derivation: ok")

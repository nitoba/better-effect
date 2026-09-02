import * as z from "zod"

import { Z } from "../src/index.js"
import type { Equal, Expect } from "./helpers.js"

class Person extends Z.Class<Person>("Person")({
  id: z.int(),
  name: z.string()
}) {
  get label(): string {
    return `${this.name} #${this.id}`
  }
}

class Employee extends Person.extend<Employee>("Employee")({
  role: z.enum(["admin", "member"])
}) {
  canManageUsers(): boolean {
    return this.role === "admin"
  }
}

class PersonSummary extends Person.pick<PersonSummary>("PersonSummary")({
  id: true
}) {}

class PersonWithoutName extends Person.omit<PersonWithoutName>("PersonWithoutName")({
  name: true
}) {}

class PersonPatch extends Person.partial<PersonPatch>("PersonPatch") {}
class NamePatch extends Person.partial<NamePatch, { readonly name: true }>("NamePatch", { name: true }) {}
class RequiredPerson extends PersonPatch.required<RequiredPerson>("RequiredPerson") {}

const employee = new Employee({ id: 1, name: "Ada", role: "admin" })
employee.label satisfies string
employee.canManageUsers() satisfies boolean

const summary = new PersonSummary({ id: 1 })
// @ts-expect-error a field excluded by pick is not part of the derived instance
summary.name
// @ts-expect-error omitted field is not accepted
new PersonSummary({ id: 1, name: "Ada" })

new PersonWithoutName({ id: 1 })
new PersonPatch()
new NamePatch({ id: 1 })
// @ts-expect-error only name was made optional
new NamePatch({ name: "Ada" })
new RequiredPerson({ id: 1, name: "Ada" })

type _RequiredIdField = Expect<Equal<
  Z.Fields<typeof RequiredPerson>["id"],
  z.ZodNonOptional<z.ZodOptional<z.ZodNumber>>
>>

type _EmployeeEncoded = Expect<Equal<
  Z.Encoded<typeof Employee>,
  { readonly id: number; readonly name: string; readonly role: "admin" | "member" }
>>

class ExactPersonPatch extends Person.exactPartial<ExactPersonPatch>("ExactPersonPatch") {}
new ExactPersonPatch()
// @ts-expect-error exact optional fields must be omitted rather than explicitly set to undefined
new ExactPersonPatch({ name: undefined })

type _ExactNameField = Expect<Equal<
  Z.Fields<typeof ExactPersonPatch>["name"],
  z.ZodExactOptional<z.ZodString>
>>

class Profile extends Z.Class<Profile>("Profile")({
  name: z.string(),
  address: z.object({
    street: z.string(),
    location: z.object({
      city: z.string()
    })
  })
}) {}

class ProfilePatch extends Profile.deepPartial<ProfilePatch>("ProfilePatch") {}
new ProfilePatch({ address: { location: {} } })

import * as z from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import { Schema, type Encoded, type Fields } from '../src/index.js'
import { ZodAdapter } from '../src/adapters/zod/index.js'
import type { Equal, Expect, Extends } from './helpers.js'

const local = Schema.with(ZodAdapter)

class Person extends local.Class<Person>('Person')({
  id: z.int(),
  name: z.string()
}) {
  get label(): string {
    return `${this.name} #${this.id}`
  }
}

class Employee extends Person.extend<Employee>('Employee')({
  role: z.enum(['admin', 'member'])
}) {
  canManageUsers(): boolean {
    return this.role === 'admin'
  }
}

class PersonSummary extends Person.pick<PersonSummary>('PersonSummary')({
  id: true
}) {}

class PersonWithoutName extends Person.omit<PersonWithoutName>('PersonWithoutName')({
  name: true
}) {}

class PersonPatch extends Person.partial<PersonPatch>('PersonPatch') {}
class NamePatch extends Person.partial<NamePatch, { readonly name: true }>('NamePatch', { name: true }) {}
class RequiredPerson extends PersonPatch.required<RequiredPerson>('RequiredPerson') {}

const employee = new Employee({ id: 1, name: 'Ada', role: 'admin' })
employee.label satisfies string
employee.canManageUsers() satisfies boolean

const summary = new PersonSummary({ id: 1 })
summary.name satisfies string
// @ts-expect-error omitted fields are not accepted
new PersonSummary({ id: 1, name: 'Ada' })

new PersonWithoutName({ id: 1 })
new PersonPatch()
new NamePatch({ id: 1 })
// @ts-expect-error only name was made optional
new NamePatch({ name: 'Ada' })
new RequiredPerson({ id: 1, name: 'Ada' })

type _RequiredIdField = Expect<Extends<Fields<typeof RequiredPerson>['id'], StandardSchemaV1>>
type _EmployeeEncoded = Expect<Equal<Encoded<typeof Employee>, { id: number; name: string; role: 'admin' | 'member' }>>

class ExactPersonPatch extends Person.exactPartial<ExactPersonPatch>('ExactPersonPatch') {}
new ExactPersonPatch()
// @ts-expect-error exact optional fields reject explicit undefined
new ExactPersonPatch({ name: undefined })

class StrictPerson extends Person.strict<StrictPerson>('StrictPerson') {}
class LoosePerson extends Person.loose<LoosePerson>('LoosePerson') {}
class StrippedPerson extends LoosePerson.strip<StrippedPerson>('StrippedPerson') {}
class MetadataPerson extends Person.catchall<MetadataPerson>('MetadataPerson')(z.string()) {}

new StrictPerson({ id: 1, name: 'Ada' })
new LoosePerson({ id: 1, name: 'Ada' })
new StrippedPerson({ id: 1, name: 'Ada' })
new MetadataPerson({ id: 1, name: 'Ada' })

class Profile extends local.Class<Profile>('Profile')({
  name: z.string(),
  address: z.object({
    street: z.string(),
    location: z.object({ city: z.string() })
  })
}) {}

class ProfilePatch extends Profile.deepPartial<ProfilePatch>('ProfilePatch') {}
new ProfilePatch({ address: { location: {} } })

import * as z from "zod"

import {
  Z,
  isClassInstance,
  type ClassKind
} from "../src/index.js"
import type { Equal, Expect, Extends } from "./helpers.js"

class Person extends Z.Class<Person>("ErgonomicPerson")({
  id: z.int(),
  name: z.string()
}) {}

Person.codec satisfies z.ZodType<Person, {
  readonly id: number
  readonly name: string
}>
Person.kind satisfies ClassKind

const candidate: unknown = new Person({ id: 1, name: "Ada" })
if (isClassInstance(candidate)) {
  candidate satisfies object
}

if (Z.isClassInstance(candidate)) {
  candidate satisfies object
}

class StrictPerson extends Person.strict<StrictPerson>("StrictTypePerson") {}
class LoosePerson extends Person.loose<LoosePerson>("LooseTypePerson") {}
class StrippedPerson extends LoosePerson.strip<StrippedPerson>("StripTypePerson") {}
class MetadataPerson extends Person.catchall<MetadataPerson>("CatchallTypePerson")(
  z.string()
) {}

new StrictPerson({ id: 1, name: "Ada" })
new LoosePerson({ id: 1, name: "Ada" })
new StrippedPerson({ id: 1, name: "Ada" })
new MetadataPerson({ id: 1, name: "Ada" })

type _StrictFields = Expect<Extends<keyof Z.Fields<typeof StrictPerson>, "id" | "name">>
type _CodecOutput = Expect<Equal<z.output<typeof Person.codec>, Person>>

class Address extends Z.Class<Address>("ErgonomicAddress")({
  city: z.string()
}) {
  format(): string {
    return this.city
  }
}

class Customer extends Z.Class<Customer>("ErgonomicCustomer")({
  address: Address
}) {}

const address = new Address({ city: "Fortaleza" })
new Customer({ address })

// Constructors accept decoded class instances, not their encoded object form.
// @ts-expect-error
new Customer({ address: { city: "Fortaleza" } })

const encodedCustomer: Z.Encoded<typeof Customer> = {
  address: { city: "Fortaleza" }
}
encodedCustomer.address.city satisfies string

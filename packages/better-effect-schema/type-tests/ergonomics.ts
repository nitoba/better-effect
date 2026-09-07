import * as z from 'zod'

import { Schema, isClassInstance, type ClassKind, type Encoded } from '../src/index.js'
import { ZodAdapter } from '../src/adapters/zod/index.js'
import type { Equal, Expect, Extends } from './helpers.js'

const local = Schema.with(ZodAdapter)

class Person extends local.Class<Person>('ErgonomicPerson')({
  id: z.int(),
  name: z.string()
}) {}

Person.codec satisfies z.ZodObject
Person.kind satisfies ClassKind

const candidate: unknown = new Person({ id: 1, name: 'Ada' })
if (isClassInstance(candidate)) candidate satisfies object

class StrictPerson extends Person.strict<StrictPerson>('StrictTypePerson') {}
class LoosePerson extends Person.loose<LoosePerson>('LooseTypePerson') {}
class StrippedPerson extends LoosePerson.strip<StrippedPerson>('StripTypePerson') {}
class MetadataPerson extends Person.catchall<MetadataPerson>('CatchallTypePerson')(z.string()) {}

new StrictPerson({ id: 1, name: 'Ada' })
new LoosePerson({ id: 1, name: 'Ada' })
new StrippedPerson({ id: 1, name: 'Ada' })
new MetadataPerson({ id: 1, name: 'Ada' })

type _CodecOutput = Expect<Equal<z.output<typeof Person.codec>, { id: number; name: string }>>

class Customer extends local.Class<Customer>('ErgonomicCustomer')({
  address: z.object({ city: z.string() })
}) {}

new Customer({ address: { city: 'Fortaleza' } })

const encodedCustomer: Encoded<typeof Customer> = { address: { city: 'Fortaleza' } }
encodedCustomer.address.city satisfies string

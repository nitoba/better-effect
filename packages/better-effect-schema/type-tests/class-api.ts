import * as z from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  Schema,
  type Encoded,
  type Instance,
  type Props,
  type Struct
} from '../src/index.js'
import { ZodAdapter } from '../src/adapters/zod/index.js'
import type { Equal, Expect, Extends } from './helpers.js'

const local = Schema.with(ZodAdapter)

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class Person extends local.Class<Person>('Person')({
  id: z.int().positive(),
  name: z.string().min(1),
  bornAt: DateFromISOString
}) {
  get label(): string {
    return `${this.name} #${this.id}`
  }
}

const person = new Person({
  id: 1,
  name: 'Ada',
  bornAt: new Date('1990-12-10T00:00:00.000Z')
})

Person.make({ id: 1, name: 'Ada', bornAt: new Date() })
Person.unsafeMake({ id: -1, name: '', bornAt: new Date() })

// @ts-expect-error validation bypass options were removed from the public API
Person.make({ id: 1, name: 'Ada', bornAt: new Date() }, { disableChecks: true })
// @ts-expect-error constructors accept decoded props only
new Person({ id: 1, name: 'Ada', bornAt: new Date() }, { disableChecks: true })
// @ts-expect-error parsing is an adapter-owned operation, not a class method
Person.parse({ id: 1, name: 'Ada', bornAt: '1990-12-10T00:00:00.000Z' })

const decoded = Schema.decodeUnknown(Person)({
  id: 1,
  name: 'Ada',
  bornAt: '1990-12-10T00:00:00.000Z'
})
decoded satisfies import('better-effect').Effect<Person, unknown, never>

const schemaCandidate: unknown = Person
if (Schema.isSchemaClass(schemaCandidate)) schemaCandidate.identifier satisfies string

// @ts-expect-error constructors receive decoded props, not encoded input
new Person({ id: 1, name: 'Ada', bornAt: '1990-12-10T00:00:00.000Z' })
// @ts-expect-error required decoded property is missing
Person.make({ id: 1, name: 'Ada' })

type ExpectedProps = {
  id: number
  name: string
  bornAt: Date
}

type ExpectedEncoded = {
  id: number
  name: string
  bornAt: string
}

type _Props = Expect<Equal<Props<typeof Person>, ExpectedProps>>
type _ExportedProps = Expect<Equal<Schema.Props<typeof Person>, ExpectedProps>>
type _Encoded = Expect<Equal<Encoded<typeof Person>, ExpectedEncoded>>
type _ExportedEncoded = Expect<Equal<Schema.Encoded<typeof Person>, ExpectedEncoded>>
type _Instance = Expect<Extends<Person, Instance<typeof Person>>>
type _Struct = Expect<Equal<Struct<typeof Person>, typeof Person.codec>>

person.label satisfies string
Schema.encode(Person, person)

const projectedEncoded: StandardSchemaV1<ExpectedEncoded, ExpectedEncoded> = Person.encodedSchema
const projectedProps: StandardSchemaV1<ExpectedProps, ExpectedProps> = Person.propsSchema
void projectedEncoded
void projectedProps

const UserWireCodec = z.codec(
  z.object({
    user_id: z.uuid(),
    display_name: z.string(),
    created_at: z.iso.datetime()
  }),
  z.object({
    id: z.uuid(),
    displayName: z.string(),
    createdAt: z.date()
  }),
  {
    decode: (input) => ({
      id: input.user_id,
      displayName: input.display_name,
      createdAt: new Date(input.created_at)
    }),
    encode: (props) => ({
      user_id: props.id,
      display_name: props.displayName,
      created_at: props.createdAt.toISOString()
    })
  }
)

class CodecUser extends local.Class<CodecUser>('CodecUser')(UserWireCodec) {
  get label(): string {
    return `${this.displayName} (${this.id})`
  }
}

new CodecUser({
  id: '123e4567-e89b-12d3-a456-426614174000',
  displayName: 'Ada',
  createdAt: new Date()
})

Schema.decode(CodecUser)({
  user_id: '123e4567-e89b-12d3-a456-426614174000',
  display_name: 'Ada',
  created_at: '2026-09-01T20:00:00.000Z'
})

type CodecUserProps = {
  id: string
  displayName: string
  createdAt: Date
}
type CodecUserEncoded = {
  user_id: string
  display_name: string
  created_at: string
}
type _CodecProps = Expect<Equal<Props<typeof CodecUser>, CodecUserProps>>
type _CodecEncoded = Expect<Equal<Encoded<typeof CodecUser>, CodecUserEncoded>>
type _CodecStruct = Expect<Equal<Struct<typeof CodecUser>, typeof UserWireCodec>>

// Whole-object codecs cannot be structurally derived safely.
// @ts-expect-error
CodecUser.partial<CodecUser>('CodecUserPatch')

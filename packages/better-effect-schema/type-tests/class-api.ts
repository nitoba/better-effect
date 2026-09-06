import * as z from "zod"

import { Z, type Encoded, type Fields, type Instance, type Props, type Struct } from "../src/index.js"
import type { Equal, Expect, Extends } from "./helpers.js"

const DateFromISOString = z.codec(
  z.iso.datetime(),
  z.date(),
  {
    decode: (value) => new Date(value),
    encode: (value) => value.toISOString()
  }
)

class Person extends Z.Class<Person>("Person")({
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
  name: "Ada",
  bornAt: new Date("1990-12-10T00:00:00.000Z")
})

Person.make({ id: 1, name: "Ada", bornAt: new Date() })
Person.unsafeMake({ id: -1, name: "", bornAt: new Date() })
// @ts-expect-error constructor validation can no longer be bypassed with options
Person.make({ id: 1, name: "Ada", bornAt: new Date() }, { disableChecks: true })
// @ts-expect-error constructors accept decoded props only, without bypass options
new Person({ id: 1, name: "Ada", bornAt: new Date() }, { disableChecks: true })
Person.parse({ id: 1, name: "Ada", bornAt: "1990-12-10T00:00:00.000Z" })
z.array(Person)
z.object({ person: Person })

const schemaCandidate: unknown = Person
if (Z.isSchemaClass(schemaCandidate)) {
  schemaCandidate.identifier satisfies string
}

// @ts-expect-error constructor receives decoded props, not encoded input
new Person({ id: 1, name: "Ada", bornAt: "1990-12-10T00:00:00.000Z" })

// @ts-expect-error required decoded property is missing
Person.make({ id: 1, name: "Ada" })

type ExpectedProps = {
  readonly id: number
  readonly name: string
  readonly bornAt: Date
}

type ExpectedEncoded = {
  readonly id: number
  readonly name: string
  readonly bornAt: string
}

type _Props = Expect<Equal<Z.Props<typeof Person>, ExpectedProps>>
type _ExportedProps = Expect<Equal<Props<typeof Person>, ExpectedProps>>
type _Encoded = Expect<Equal<Z.Encoded<typeof Person>, ExpectedEncoded>>
type _ExportedEncoded = Expect<Equal<Encoded<typeof Person>, ExpectedEncoded>>
type _Output = Expect<Equal<z.output<typeof Person>, Person>>
type _Instance = Expect<Equal<Z.Instance<typeof Person>, Person>>
type _ExportedInstance = Expect<Equal<Instance<typeof Person>, Person>>
type _Fields = Expect<Extends<keyof Fields<typeof Person>, "id" | "name" | "bornAt">>
type _Struct = Expect<Extends<Struct<typeof Person>, z.ZodObject>>

person.label satisfies string

const projectedEncoded: z.ZodType<ExpectedEncoded, ExpectedEncoded> = Person.encodedSchema
const projectedProps: z.ZodType<ExpectedProps, ExpectedProps> = Person.propsSchema
void projectedEncoded
void projectedProps

const safePerson = Person.safeMake({ id: 1, name: "Ada", bornAt: new Date() })
if (safePerson.success) {
  safePerson.data.label satisfies string
}

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

class CodecUser extends Z.Class<CodecUser>("CodecUser")(UserWireCodec) {
  get label(): string {
    return `${this.displayName} (${this.id})`
  }
}

new CodecUser({
  id: "123e4567-e89b-12d3-a456-426614174000",
  displayName: "Ada",
  createdAt: new Date()
})

CodecUser.parse({
  user_id: "123e4567-e89b-12d3-a456-426614174000",
  display_name: "Ada",
  created_at: "2026-09-01T20:00:00.000Z"
})

type CodecUserProps = {
  readonly id: string
  readonly displayName: string
  readonly createdAt: Date
}
type CodecUserEncoded = {
  readonly user_id: string
  readonly display_name: string
  readonly created_at: string
}
type _CodecProps = Expect<Equal<Z.Props<typeof CodecUser>, CodecUserProps>>
type _CodecEncoded = Expect<Equal<Z.Encoded<typeof CodecUser>, CodecUserEncoded>>
type _CodecStruct = Expect<Equal<Z.Struct<typeof CodecUser>, typeof UserWireCodec>>
type _CodecFields = Expect<Extends<keyof Z.Fields<typeof CodecUser>, "id" | "displayName" | "createdAt">>

// @ts-expect-error whole-object codec mappings cannot be structurally derived safely
CodecUser.partial<CodecUser>("CodecUserPatch")

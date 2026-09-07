import * as z from "zod"
import { Result } from "better-result"
import { Schema } from "better-effect-schema"
import { ZodAdapter } from "better-effect-schema/zod"

const local = Schema.with(ZodAdapter)

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) throw new Error(message)
}

const DateFromISOString = z.codec(
  z.iso.datetime(),
  z.date(),
  {
    decode: (value) => new Date(value),
    encode: (value) => value.toISOString()
  }
)

class Person extends local.Class<Person>("examples/Person")({
  id: z.int().positive(),
  name: z.string().min(1),
  bornAt: DateFromISOString
}) {
  get label(): string {
    return `${this.name} #${this.id}`
  }
}

const decoded = Schema.decode(Person, {
  id: 1,
  name: "Ada",
  bornAt: "1990-12-10T00:00:00.000Z"
})

if (Result.isError(decoded)) throw decoded.error
assert(decoded.value instanceof Person, "decode must return Person")
assert(decoded.value.bornAt instanceof Date, "field codec must decode Date")
assert(decoded.value.label === "Ada #1", "class behavior must be preserved")

const constructed = new Person({
  id: 2,
  name: "Grace",
  bornAt: new Date("1906-12-09T00:00:00.000Z")
})

const encoded = Schema.encode(Person, constructed)
if (Result.isError(encoded)) throw encoded.error
assert(typeof encoded.value.bornAt === "string", "encode must restore ISO string")

const People = z.array(z.object({
  id: z.int(),
  name: z.string(),
  bornAt: z.iso.datetime()
}))
const peopleResult = Schema.decodeUnknown(People, [{
  id: 3,
  name: "Katherine",
  bornAt: "1918-08-26T00:00:00.000Z"
}])
if (Result.isError(peopleResult)) throw peopleResult.error
assert(peopleResult.value[0]?.name === "Katherine", "native provider schemas remain usable")

console.log("basic: ok")

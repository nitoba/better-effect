import * as z from "zod"
import { Schema } from "better-effect-zod"

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

class Person extends Schema.Class<Person>("examples/Person")({
  id: z.int().positive(),
  name: z.string().min(1),
  bornAt: DateFromISOString
}) {
  get label(): string {
    return `${this.name} #${this.id}`
  }
}

const decoded = Person.parse({
  id: 1,
  name: "Ada",
  bornAt: "1990-12-10T00:00:00.000Z"
})

assert(decoded instanceof Person, "parse must return Person")
assert(decoded.bornAt instanceof Date, "field codec must decode Date")
assert(decoded.label === "Ada #1", "class behavior must be preserved")

const constructed = new Person({
  id: 2,
  name: "Grace",
  bornAt: new Date("1906-12-09T00:00:00.000Z")
})

const encoded = Person.encode(constructed)
assert(typeof encoded.bornAt === "string", "encode must restore ISO string")

const People = z.array(Person)
const people = People.parse([{
  id: 3,
  name: "Katherine",
  bornAt: "1918-08-26T00:00:00.000Z"
}])
assert(people[0] instanceof Person, "nested schemas must create instances")

console.log("basic: ok")

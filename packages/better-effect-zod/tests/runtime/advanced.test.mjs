import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"

import { Z } from "../../dist/esm/index.js"

test("metadata remains attached to the class identity", () => {
  class Person extends Z.Class("Person", {
    id: "urn:example:person",
    title: "Person",
    description: "A registered person",
    examples: [{ id: 1, name: "Ada" }]
  })({
    id: z.int(),
    name: z.string()
  }) {}

  assert.deepEqual(Person.meta(), {
    id: "urn:example:person",
    title: "Person",
    description: "A registered person",
    examples: [{ id: 1, name: "Ada" }]
  })

  const optionalPerson = Person.optional()
  assert.equal(Person.describe("An updated person"), Person)
  assert.equal(Person.meta().description, "An updated person")
  assert.equal(
    z.globalRegistry.get(optionalPerson.innerType).description,
    "An updated person"
  )

  const entries = new Map()
  const registry = {
    add(schema, metadata) {
      entries.set(schema, metadata)
      return this
    }
  }

  assert.equal(Person.register(registry, { source: "advanced-test" }), Person)
  assert.deepEqual(entries.get(Person), { source: "advanced-test" })
})

test("JSON Schema is generated from the encoded input side", () => {
  const DateFromISOString = z.codec(
    z.iso.datetime(),
    z.date(),
    {
      decode: (value) => new Date(value),
      encode: (value) => value.toISOString()
    }
  )

  class Person extends Z.Class("JsonPerson")({
    id: z.int(),
    bornAt: DateFromISOString
  }) {}

  const schema = z.toJSONSchema(Person, { io: "input" })
  const viaClass = Person.toJSONSchema({ io: "input" })
  const viaClassDefault = Person.toJSONSchema()

  assert.equal(schema.type, "object")
  assert.equal(schema.properties.id.type, "number")
  assert.equal(schema.properties.bornAt.type, "string")
  assert.deepEqual(schema.required, ["id", "bornAt"])
  assert.deepEqual(viaClass, schema)
  assert.deepEqual(viaClassDefault, schema)
})

test("makeAsync validates asynchronous object refinements", async () => {
  const AsyncAccountStruct = z.object({
    username: z.string()
  }).superRefine(async (value, context) => {
    await Promise.resolve()
    if (value.username === "taken") {
      context.addIssue({
        code: "custom",
        message: "Username is already taken"
      })
    }
  })

  class AsyncAccount extends Z.Class("AsyncAccount")(AsyncAccountStruct) {}

  assert.throws(() => new AsyncAccount({ username: "available" }))
  await assert.rejects(
    () => AsyncAccount.makeAsync({ username: "taken" }),
    z.ZodError
  )

  const account = await AsyncAccount.makeAsync({ username: "available" })
  assert.ok(account instanceof AsyncAccount)
  assert.equal(account.username, "available")
})

test("prevalidated async construction survives a user-defined constructor", async () => {
  const AsyncAccountStruct = z.object({
    username: z.string()
  }).superRefine(async () => {
    await Promise.resolve()
  })

  class AsyncAccount extends Z.Class("AsyncAccountWithConstructor")(
    AsyncAccountStruct
  ) {
    constructor(props) {
      super(props)
      this.initialized = true
    }
  }

  const parsed = await AsyncAccount.parseAsync({ username: "ada" })
  assert.ok(parsed instanceof AsyncAccount)
  assert.equal(parsed.initialized, true)

  const made = await AsyncAccount.makeAsync({ username: "grace" })
  assert.ok(made instanceof AsyncAccount)
  assert.equal(made.initialized, true)
})

test("async codecs remain bidirectional through class methods", async () => {
  const AsyncUppercase = z.codec(
    z.string(),
    z.string(),
    {
      async decode(value) {
        await Promise.resolve()
        return value.toUpperCase()
      },
      async encode(value) {
        await Promise.resolve()
        return value.toLowerCase()
      }
    }
  )

  class AsyncValue extends Z.Class("AsyncValue")({
    value: AsyncUppercase
  }) {}

  const decoded = await AsyncValue.parseAsync({ value: "hello" })
  assert.ok(decoded instanceof AsyncValue)
  assert.equal(decoded.value, "HELLO")

  const made = await AsyncValue.makeAsync({ value: "WORLD" })
  assert.ok(made instanceof AsyncValue)
  assert.deepEqual(await AsyncValue.encodeAsync(made), { value: "world" })
})

test("recursive fields decode and encode concrete instances", () => {
  class Category extends Z.Class("Category")({
    name: z.string(),
    children: z.array(z.lazy(() => Category))
  }) {}

  const category = Category.parse({
    name: "root",
    children: [
      {
        name: "child",
        children: []
      }
    ]
  })

  assert.ok(category instanceof Category)
  assert.ok(category.children[0] instanceof Category)
  assert.deepEqual(Category.encode(category), {
    name: "root",
    children: [
      {
        name: "child",
        children: []
      }
    ]
  })
})

test("full ZodObject definitions preserve strictness and refinements", () => {
  const AccountStruct = z.strictObject({
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

  class Account extends Z.Class("StrictAccount")(AccountStruct) {}

  assert.throws(
    () => Account.parse({ id: 1, name: "Ada", extra: true }),
    z.ZodError
  )
  assert.throws(
    () => Account.parse({ id: 2, name: "admin" }),
    z.ZodError
  )
  assert.ok(Account.parse({ id: 1, name: "admin" }) instanceof Account)
})

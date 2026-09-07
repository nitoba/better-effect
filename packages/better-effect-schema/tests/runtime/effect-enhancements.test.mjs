import assert from "node:assert/strict"
import test from "node:test"
import * as z from "zod"

import { Z, ZodClassError } from "../../dist/esm/index.js"

const DateFromISOString = z.codec(
  z.iso.datetime(),
  z.date(),
  {
    decode: (value) => new Date(value),
    encode: (value) => value.toISOString()
  }
)

class Person extends Z.Class("ProjectionPerson")({
  id: z.int().positive(),
  name: z.string().min(1),
  bornAt: DateFromISOString
}) {}

test("encodedSchema validates wire values without constructing the class", () => {
  const encoded = Person.encodedSchema.parse({
    id: 1,
    name: "Ada",
    bornAt: "1815-12-10T00:00:00.000Z"
  })

  assert.deepEqual(encoded, {
    id: 1,
    name: "Ada",
    bornAt: "1815-12-10T00:00:00.000Z"
  })
  assert.equal(encoded instanceof Person, false)
  assert.throws(() => Person.encodedSchema.parse({ id: 0, name: "", bornAt: "nope" }), z.ZodError)
})

test("propsSchema validates decoded constructor props without constructing the class", () => {
  const date = new Date("1815-12-10T00:00:00.000Z")
  const props = Person.propsSchema.parse({ id: 1, name: "Ada", bornAt: date })

  assert.equal(props.bornAt, date)
  assert.equal(props instanceof Person, false)
  assert.throws(() => Person.propsSchema.parse({ id: 1, name: "Ada", bornAt: "1815-12-10T00:00:00.000Z" }), z.ZodError)
})

test("safeMake returns a Zod safe result for decoded props", () => {
  const bad = Person.safeMake({ id: 0, name: "", bornAt: new Date() })
  assert.equal(bad.success, false)
  if (!bad.success) assert.ok(bad.error instanceof z.ZodError)

  const good = Person.safeMake({ id: 1, name: "Ada", bornAt: new Date() })
  assert.equal(good.success, true)
  if (good.success) assert.ok(good.data instanceof Person)
})

test("safeMakeAsync supports asynchronous decoded-prop validation", async () => {
  const AccountStruct = z.object({ username: z.string() }).superRefine(async (value, ctx) => {
    await Promise.resolve()
    if (value.username === "taken") ctx.addIssue({ code: "custom", message: "taken" })
  })

  class Account extends Z.Class("SafeAsyncAccount")(AccountStruct) {}

  const bad = await Account.safeMakeAsync({ username: "taken" })
  assert.equal(bad.success, false)

  const good = await Account.safeMakeAsync({ username: "available" })
  assert.equal(good.success, true)
  if (good.success) assert.ok(good.data instanceof Account)
})

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

class CodecUser extends Z.Class("CodecUser")(UserWireCodec) {
  get label() {
    return `${this.displayName} (${this.id})`
  }
}

const encodedUser = {
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  display_name: "Ada",
  created_at: "2026-09-01T20:00:00.000Z"
}

test("whole-object codecs decode wire objects into class instances", () => {
  const user = CodecUser.parse(encodedUser)
  assert.ok(user instanceof CodecUser)
  assert.equal(user.displayName, "Ada")
  assert.ok(user.createdAt instanceof Date)
  assert.equal(user.label, `Ada (${encodedUser.user_id})`)
  assert.deepEqual(CodecUser.encode(user), encodedUser)
})

test("codec-backed constructors consume decoded props", () => {
  const user = new CodecUser({
    id: encodedUser.user_id,
    displayName: "Ada",
    createdAt: new Date(encodedUser.created_at)
  })
  assert.ok(user instanceof CodecUser)
  assert.equal(user.displayName, "Ada")
  assert.throws(() => new CodecUser(encodedUser), z.ZodError)
})

test("codec-backed classes expose encoded and props projections", () => {
  const wire = CodecUser.encodedSchema.parse(encodedUser)
  const props = CodecUser.propsSchema.parse({
    id: encodedUser.user_id,
    displayName: "Ada",
    createdAt: new Date(encodedUser.created_at)
  })

  assert.deepEqual(wire, encodedUser)
  assert.equal(props.displayName, "Ada")
  assert.ok(props.createdAt instanceof Date)
  assert.equal(CodecUser.fields.displayName.type, "string")
  assert.equal(CodecUser.struct, UserWireCodec)
})

test("arbitrary whole-object codecs reject structural class derivation", () => {
  assert.throws(
    () => CodecUser.partial("CodecUserPatch"),
    (error) => error instanceof ZodClassError && error.code === "INVALID_DERIVATION"
  )
})

test("exactPartial delegates exact optional semantics while preserving the class", () => {
  class ExactPatch extends Person.exactPartial("ExactPatch") {}

  const empty = new ExactPatch()
  assert.ok(empty instanceof ExactPatch)
  assert.throws(() => new ExactPatch({ name: undefined }), z.ZodError)
  assert.ok(ExactPatch.fields.name instanceof z.ZodExactOptional)
})

test("deepPartial recursively optionalizes nested object fields while preserving the class", () => {
  class Profile extends Z.Class("Profile")({
    name: z.string(),
    address: z.object({
      street: z.string(),
      location: z.object({ city: z.string() })
    })
  }) {}
  class ProfilePatch extends Profile.deepPartial("ProfilePatch") {}

  const patch = new ProfilePatch({ address: { location: {} } })
  assert.ok(patch instanceof ProfilePatch)
  assert.deepEqual(patch.address, { location: {} })
})

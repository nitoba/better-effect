import assert from 'node:assert/strict'
import { test } from 'bun:test'

import { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation,
  isClassInstance,
  isSchemaClass
} from '../../dist/esm/index.js'

const standard = (vendor, validate) => ({
  '~standard': { version: 1, vendor, validate }
})

const objectSchema = (transform) =>
  standard('generic-test', (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { issues: [{ message: 'expected object' }] }
    }
    return transform(value)
  })

test('Schema.Class builds real instances from explicit Standard Schema capabilities', () => {
  let inputCalls = 0
  let propsCalls = 0

  const input = objectSchema((value) => {
    inputCalls += 1
    return typeof value.name === 'string'
      ? { value: { name: value.name.trim() } }
      : { issues: [{ message: 'name is required' }] }
  })
  const props = objectSchema((value) => {
    propsCalls += 1
    return typeof value.name === 'string'
      ? { value: { name: value.name, count: value.count ?? 1 } }
      : { issues: [{ message: 'name is required' }] }
  })

  class User extends Schema.Class('generic/User')({ schema: input, propsSchema: props }) {
    #secret = 'private'
    upperName = this.name.toUpperCase()

    get label() {
      return `${this.upperName}:${this.count}:${this.#secret}`
    }
  }

  const result = User.make({ name: ' Ada ' })
  assert.equal(Result.isOk(result), true)
  assert.equal(result.value.label, ' ADA :1:private')
  assert.equal(result.value instanceof User, true)
  assert.equal(User.is(result.value), true)
  assert.equal(isClassInstance(result.value), true)
  assert.equal(isSchemaClass(User), true)
  assert.equal(inputCalls, 0)
  assert.equal(propsCalls, 1)
  assert.equal(User.fields, undefined)
  assert.equal(User.encodedSchema, undefined)
  assert.equal(User.struct, undefined)
  assert.equal(User.codec, undefined)
})

test('decode validates the external schema once and constructs from its output', () => {
  let decodeCalls = 0
  let propsCalls = 0
  const schema = objectSchema((value) => {
    decodeCalls += 1
    return typeof value.name === 'string'
      ? { value: { name: value.name } }
      : { issues: [{ message: 'bad input' }] }
  })
  const propsSchema = objectSchema((value) => {
    propsCalls += 1
    return { value: { name: value.name, count: 2 } }
  })

  class User extends Schema.Class('generic/DecodeUser')({ schema, propsSchema }) {}

  const result = Schema.decodeUnknown(User, { name: 'Ada' })
  assert.equal(Result.isOk(result), true)
  assert.equal(result.value.name, 'Ada')
  assert.equal(result.value.count, 2)
  assert.equal(result.value instanceof User, true)
  assert.equal(decodeCalls, 1)
  assert.equal(propsCalls, 1)
})

test('generic encoding uses only the declared capability and encoded projection', () => {
  let encodeCalls = 0
  let encodedCalls = 0
  const schema = objectSchema((value) => ({ value: { name: value.name } }))
  const encodedSchema = objectSchema((value) => {
    encodedCalls += 1
    return typeof value.wireName === 'string'
      ? { value }
      : { issues: [{ message: 'wireName is required' }] }
  })

  class User extends Schema.Class('generic/EncodedUser')({
    schema,
    propsSchema: schema,
    encodedSchema,
    encode(instance) {
      encodeCalls += 1
      return { wireName: instance.name.toUpperCase() }
    }
  }) {}

  const made = User.make({ name: 'Ada' })
  assert.equal(Result.isOk(made), true)
  const encoded = Schema.encode(User, made.value)
  assert.equal(Result.isOk(encoded), true)
  assert.deepEqual(encoded.value, { wireName: 'ADA' })
  assert.equal(encodeCalls, 1)
  assert.equal(encodedCalls, 1)

  class ReadOnly extends Schema.Class('generic/ReadOnly')({
    schema,
    propsSchema: schema
  }) {}
  const readOnly = ReadOnly.make({ name: 'Ada' })
  assert.equal(Result.isOk(readOnly), true)
  const unsupported = Schema.encode(ReadOnly, readOnly.value)
  assert.equal(Result.isError(unsupported), true)
  assert.equal(unsupported.error instanceof SchemaUnsupportedOperation, true)
})

test('sync construction reports async providers without retrying or rejecting', async () => {
  let calls = 0
  const schema = objectSchema((value) => ({ value }))
  const asyncProps = objectSchema(() => {
    calls += 1
    return Promise.resolve({ value: { name: 'Ada' } })
  })
  class User extends Schema.Class('generic/AsyncUser')({ schema, propsSchema: asyncProps }) {}

  const sync = User.make({ name: 'Ada' })
  assert.equal(Result.isError(sync), true)
  assert.equal(sync.error instanceof SchemaAsyncRequired, true)
  assert.equal(calls, 1)

  const async = await User.makeAsync({ name: 'Ada' })
  assert.equal(Result.isOk(async), true)
  assert.equal(async.value instanceof User, true)
  assert.equal(calls, 2)
})

test('definition and constructor failures stay typed and never fall back to permissive schemas', () => {
  const valid = objectSchema((value) => ({ value }))

  class Invalid extends Schema.Class('')({ schema: valid, propsSchema: valid }) {}
  const definition = Schema.check(Invalid)
  assert.equal(Result.isError(definition), true)
  assert.equal(definition.error instanceof SchemaDefinitionFailure, true)
  assert.equal(Result.isError(Invalid.make({ name: 'Ada' })), true)

  class Throws extends Schema.Class('generic/Throws')({ schema: valid, propsSchema: valid }) {
    constructor(props) {
      super(props)
      throw new Error('constructor exploded')
    }
  }
  const constructed = Throws.make({ name: 'Ada' })
  assert.equal(Result.isError(constructed), true)
  assert.equal(constructed.error instanceof SchemaConstructionFailure, true)

  const throwingDefinition = {
    get schema() {
      throw new Error('definition getter exploded')
    },
    propsSchema: valid
  }
  class Broken extends Schema.Class('generic/Broken')(throwingDefinition) {}
  const checked = Schema.check(Broken)
  assert.equal(Result.isError(checked), true)
  assert.equal(checked.error instanceof SchemaExecutionFailure, true)
})

test('unsafeMake skips data validation but still uses the real constructor and safe identity', () => {
  const rejecting = objectSchema(() => ({ issues: [{ message: 'always invalid' }] }))
  class User extends Schema.Class('generic/UnsafeUser')({
    schema: rejecting,
    propsSchema: rejecting
  }) {
    initialized = true
  }

  const unsafeInput = { name: 'Ada' }
  Object.defineProperty(unsafeInput, '__proto__', {
    configurable: true,
    enumerable: true,
    value: { polluted: true },
    writable: true
  })
  const result = User.unsafeMake(unsafeInput)
  assert.equal(Result.isOk(result), true)
  assert.equal(result.value.initialized, true)
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(result.value, '__proto__'), true)

  const fake = Object.create(User.prototype)
  assert.equal(User.is(fake), false)
  assert.equal(fake instanceof User, false)
  assert.equal(isClassInstance(fake), false)
})

test('logical identifiers survive class re-evaluation without accepting structural fakes', () => {
  const schema = objectSchema((value) => ({ value }))
  class First extends Schema.Class('generic/StableIdentity')({ schema, propsSchema: schema }) {}
  const first = First.make({ name: 'Ada' })
  assert.equal(Result.isOk(first), true)

  class Reloaded extends Schema.Class('generic/StableIdentity')({ schema, propsSchema: schema }) {}
  assert.equal(Reloaded.is(first.value), true)
  assert.equal(first.value instanceof Reloaded, true)
  assert.equal(Reloaded.is({ name: 'Ada' }), false)
})

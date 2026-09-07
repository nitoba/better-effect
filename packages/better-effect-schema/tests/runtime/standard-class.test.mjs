import { expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Schema } from '../../dist/esm/index.js'

const standardOf = (schema) => schema['~standard']

const standard = (vendor, validate) => ({
  '~standard': { version: 1, vendor, validate }
})

const objectSchema = (transform) =>
  standard('standard-test', (value, options) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { issues: [{ message: 'expected object' }] }
    }
    return transform(value, options)
  })

const stringSchema = standard('standard-test', (value) => {
  if (typeof value !== 'string') return { issues: [{ message: 'expected string' }] }
  return { value }
})

test('exposes provider-neutral Class through the Standard Schema protocol', async () => {
  let inputValidations = 0
  let propValidations = 0
  let constructions = 0
  let receivedOptions

  const input = objectSchema((value, options) => {
    inputValidations += 1
    receivedOptions = options
    return typeof value.id === 'string'
      ? { value: { id: value.id.toUpperCase() } }
      : { issues: [{ message: 'id is required' }] }
  })
  const props = objectSchema((value) => {
    propValidations += 1
    return typeof value.id === 'string' ? { value } : { issues: [{ message: 'id is required' }] }
  })

  class User extends Schema.Class('standard/User')({ schema: input, propsSchema: props }) {
    constructor(value) {
      constructions += 1
      super(value)
    }

    get label() {
      return `user:${this.id}`
    }
  }

  const standard = standardOf(User)
  expect(standard.version).toBe(1)
  expect(standard.vendor).toBe('better-effect-schema')
  expect('types' in standard).toBe(false)

  const result = await standard.validate({ id: 'u-1' }, { libraryOptions: { trace: true } })

  expect(result).toHaveProperty('value')
  expect(result).not.toHaveProperty('status')
  if ('value' in result) {
    expect(result.value).toBeInstanceOf(User)
    expect(result.value.label).toBe('user:U-1')
  }
  expect(inputValidations).toBe(1)
  expect(propValidations).toBe(1)
  expect(constructions).toBe(1)
  expect(receivedOptions).toEqual({ libraryOptions: { trace: true } })
})

test('returns Standard Schema issues for invalid input and thrown construction', async () => {
  const input = objectSchema((value) =>
    typeof value.id === 'string' ? { value } : { issues: [{ message: 'bad input' }] }
  )
  const props = objectSchema((value) => ({ value }))

  class Invalid extends Schema.Class('standard/Invalid')({ schema: input, propsSchema: props }) {}

  const invalid = await standardOf(Invalid).validate({ id: 1 })
  expect('issues' in invalid).toBe(true)
  expect('value' in invalid).toBe(false)
  if ('issues' in invalid) {
    expect(invalid.issues.length).toBeGreaterThan(0)
    expect(invalid.issues[0].message).toBe('Validation failed')
  }

  class Throws extends Schema.Class('standard/Throws')({ schema: input, propsSchema: props }) {
    constructor(value) {
      super(value)
      throw new Error('secret constructor detail')
    }
  }

  const thrown = await standardOf(Throws).validate({ id: 'ok' })
  expect('issues' in thrown).toBe(true)
  expect('value' in thrown).toBe(false)
  if ('issues' in thrown) {
    expect(thrown.issues[0].message).toBe('Validation failed')
    expect(JSON.stringify(thrown)).not.toContain('secret constructor detail')
  }
})

test('supports asynchronous validation without a second execution', async () => {
  let validations = 0
  let constructions = 0
  const input = standard('standard-test', async (value) => {
    validations += 1
    return typeof value === 'object' && value !== null && typeof value.id === 'string'
      ? { value: { id: value.id.toUpperCase() } }
      : { issues: [{ message: 'bad input' }] }
  })
  const props = objectSchema((value) => ({ value }))

  class AsyncUser extends Schema.Class('standard/AsyncUser')({
    schema: input,
    propsSchema: props
  }) {
    constructor(value) {
      constructions += 1
      super(value)
    }
  }

  const result = await standardOf(AsyncUser).validate({ id: 'u-2' })

  expect('value' in result).toBe(true)
  if ('value' in result) expect(result.value).toBeInstanceOf(AsyncUser)
  expect(validations).toBe(1)
  expect(constructions).toBe(1)
})

test('keeps the facade Result boundary separate from the protocol result', async () => {
  const input = objectSchema((value) => ({ value }))
  const props = objectSchema((value) => ({ value }))
  class User extends Schema.Class('standard/FacadeUser')({ schema: input, propsSchema: props }) {}

  const syncDecoded = Schema.decodeUnknown(User, { id: 'u-sync' })
  expect(Result.isOk(syncDecoded)).toBe(true)

  const decoded = await Schema.decodeUnknownAsync(User, { id: 'u-3' })
  expect(Result.isOk(decoded)).toBe(true)
  if (Result.isOk(decoded)) expect(decoded.value).toBeInstanceOf(User)
})

test('TaggedClass and TaggedError return successful instances through Standard Schema', async () => {
  class UserCreated extends Schema.TaggedClass()('standard/UserCreated', {
    id: stringSchema
  }) {}

  class UserNotFound extends Schema.TaggedError()('standard/UserNotFound', {
    id: stringSchema
  }) {}

  const taggedClass = await standardOf(UserCreated).validate(
    { _tag: 'standard/UserCreated', id: 'u-4' },
    { libraryOptions: { source: 'tagged' } }
  )
  expect('value' in taggedClass).toBe(true)
  if ('value' in taggedClass) {
    expect(taggedClass.value).toBeInstanceOf(UserCreated)
    expect(taggedClass.value._tag).toBe('standard/UserCreated')
  }

  const taggedError = await standardOf(UserNotFound).validate({
    _tag: 'standard/UserNotFound',
    id: 'u-5'
  })
  expect('value' in taggedError).toBe(true)
  if ('value' in taggedError) {
    expect(taggedError.value).toBeInstanceOf(UserNotFound)
    expect(taggedError.value).toBeInstanceOf(Error)
  }
})

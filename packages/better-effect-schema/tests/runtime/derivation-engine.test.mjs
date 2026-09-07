import assert from 'node:assert/strict'
import test from 'node:test'
import { Result } from 'better-result'

import { createDerivationEngine } from '../../dist/esm/derivation/index.js'
import {
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../dist/esm/index.js'

const tagKey = Symbol('protected-tag')
const nameField = Object.freeze({ kind: 'string' })
const tagField = Object.freeze({ kind: 'literal', value: 'Root' })
const fields = Object.create(null)
Object.defineProperties(fields, {
  [tagKey]: { configurable: true, enumerable: true, value: tagField, writable: true },
  ['__proto__']: {
    configurable: true,
    enumerable: true,
    value: Object.freeze({ kind: 'string' }),
    writable: true
  },
  constructor: {
    configurable: true,
    enumerable: true,
    value: Object.freeze({ kind: 'number' }),
    writable: true
  },
  ['1']: {
    configurable: true,
    enumerable: true,
    value: Object.freeze({ kind: 'number' }),
    writable: true
  },
  name: { configurable: true, enumerable: true, value: nameField, writable: true }
})
Object.freeze(fields)

const createFixture = (overrides = {}) => {
  const calls = []
  const capabilities = {
    structure: {
      fields(schema) {
        calls.push(['fields', schema])
        return Result.ok(schema.fields)
      },
      policy(schema, policy, catchall, options) {
        calls.push(['policy', policy, catchall, options])
        return Result.ok(Object.freeze({ ...schema, policy, catchall }))
      }
    },
    derivation: {
      derive(schema, operation, config) {
        calls.push([operation, config])
        if (operation === 'deepPartial' && schema.child !== undefined) {
          const child = config.context.derive(schema.child, 'deepPartial')
          if (Result.isError(child)) return child
          return Result.ok(Object.freeze({ ...schema, operation, child: child.value }))
        }
        return Result.ok(Object.freeze({ ...schema, operation, config }))
      }
    },
    ...overrides
  }
  return { calls, engine: createDerivationEngine(capabilities) }
}

const source = Object.freeze({ fields, refinement: 'keep-me', codec: 'opaque' })

test('dispatches every structural operation with an immutable semantic request', () => {
  const { calls, engine } = createFixture()

  const extended = engine.extend(
    source,
    { extra: Object.freeze({ kind: 'boolean' }) },
    {
      identifier: 'ExtendedRoot',
      protectedKeys: [tagKey]
    }
  )
  assert.equal(Result.isOk(extended), true)
  if (Result.isOk(extended)) assert.equal(extended.value.config.identifier, 'ExtendedRoot')

  const picked = engine.pick(source, { name: true }, { protectedKeys: [tagKey] })
  assert.equal(Result.isOk(picked), true)
  if (Result.isOk(picked)) {
    const config = calls.find(([operation]) => operation === 'pick')[1]
    assert.deepEqual(config.keys, ['name', tagKey])
    assert.equal(config.fields[tagKey], tagField)
    assert.equal(Object.isFrozen(config), true)
    assert.equal(Object.isFrozen(config.keys), true)
    assert.equal(Object.isFrozen(config.fields), true)
  }

  const pickedTag = engine.pick(source, { [tagKey]: true }, { protectedKeys: [tagKey] })
  assert.equal(Result.isOk(pickedTag), true)
  if (Result.isOk(pickedTag)) assert.deepEqual(pickedTag.value.config.keys, [tagKey])

  const omitted = engine.omit(source, { name: true }, { protectedKeys: [tagKey] })
  assert.equal(Result.isOk(omitted), true)

  const partial = engine.partial(source, undefined, { protectedKeys: [tagKey] })
  assert.equal(Result.isOk(partial), true)
  const partialCall = calls.find(([operation]) => operation === 'partial')
  assert.equal(partialCall[1].partialMode, 'optional')
  assert.equal(partialCall[1].keys.includes(tagKey), false)

  const exactPartial = engine.exactPartial(source, { name: true }, { protectedKeys: [tagKey] })
  assert.equal(Result.isOk(exactPartial), true)
  const exactCall = calls.find(([operation]) => operation === 'exactPartial')
  assert.equal(exactCall[1].partialMode, 'exactOptional')

  const required = engine.required(source, { name: true }, { protectedKeys: [tagKey] })
  assert.equal(Result.isOk(required), true)
  assert.deepEqual(calls.find(([operation]) => operation === 'required')[1].keys, ['name'])

  for (const policy of ['strict', 'loose', 'strip']) {
    const result = engine.policy(source, policy)
    assert.equal(Result.isOk(result), true)
  }
  assert.equal(Result.isOk(engine.catchall(source, nameField, { protectedKeys: [tagKey] })), true)
  assert.equal(calls.at(-1)[0], 'policy')
  assert.deepEqual(calls.at(-1)[3].protectedKeys, [tagKey])

  const explicitUndefined = engine.catchall(source, undefined)
  assert.equal(Result.isOk(explicitUndefined), true)

  assert.equal(source.refinement, 'keep-me')
  assert.equal(source.codec, 'opaque')
})

test('preserves dangerous and symbol keys without prototype pollution', () => {
  const { engine } = createFixture()
  const result = engine.pick(
    source,
    { ['__proto__']: true, constructor: true },
    { protectedKeys: [tagKey] }
  )

  assert.equal(Result.isOk(result), true)
  if (Result.isOk(result)) {
    assert.deepEqual(result.value.config.keys, ['__proto__', 'constructor', tagKey])
    assert.equal(Object.getPrototypeOf(result.value.config.mask), null)
  }

  const originalMask = { name: true }
  const before = Object.getOwnPropertyDescriptor(originalMask, 'name')
  engine.pick(source, originalMask, { protectedKeys: [tagKey] })
  assert.deepEqual(Object.getOwnPropertyDescriptor(originalMask, 'name'), before)
})

test('rejects invalid masks and protected-field changes before provider dispatch', () => {
  const { calls, engine } = createFixture()
  const initialCalls = calls.filter(([operation]) => operation !== 'fields').length

  for (const mask of [{ name: false }, { missing: true }, null, []]) {
    const result = engine.pick(source, mask, { protectedKeys: [tagKey] })
    assert.equal(Result.isError(result), true)
    if (Result.isError(result)) assert.ok(result.error instanceof SchemaDefinitionFailure)
  }

  const protectedOmit = engine.omit(source, { [tagKey]: true }, { protectedKeys: [tagKey] })
  assert.equal(Result.isError(protectedOmit), true)
  if (Result.isError(protectedOmit))
    assert.ok(protectedOmit.error instanceof SchemaDefinitionFailure)

  const numericProtected = engine.omit(source, { ['1']: true }, { protectedKeys: [1] })
  assert.equal(Result.isError(numericProtected), true)
  if (Result.isError(numericProtected))
    assert.ok(numericProtected.error instanceof SchemaDefinitionFailure)

  const badExtension = engine.extend(source, { [tagKey]: nameField }, { protectedKeys: [tagKey] })
  assert.equal(Result.isError(badExtension), true)
  if (Result.isError(badExtension)) assert.ok(badExtension.error instanceof SchemaDefinitionFailure)
  assert.equal(calls.filter(([operation]) => operation !== 'fields').length, initialCalls)

  const invalidIdentifier = engine.extend(source, { extra: nameField }, { identifier: '  ' })
  assert.equal(Result.isError(invalidIdentifier), true)
  if (Result.isError(invalidIdentifier))
    assert.ok(invalidIdentifier.error instanceof SchemaDefinitionFailure)

  const invalidPolicyArguments = engine.policy(source, 'strict', nameField)
  assert.equal(Result.isError(invalidPolicyArguments), true)
  if (Result.isError(invalidPolicyArguments))
    assert.ok(invalidPolicyArguments.error instanceof SchemaDefinitionFailure)

  const missingCatchall = engine.policy(source, 'catchall')
  assert.equal(Result.isError(missingCatchall), true)
  if (Result.isError(missingCatchall))
    assert.ok(missingCatchall.error instanceof SchemaDefinitionFailure)
})

test('does not invent semantics when a capability is absent', () => {
  const fieldsOnly = createDerivationEngine({
    structure: { fields: () => Result.ok(fields) }
  })
  const missingDerivation = fieldsOnly.extend(source, { extra: nameField })
  assert.equal(Result.isError(missingDerivation), true)
  if (Result.isError(missingDerivation)) {
    assert.ok(missingDerivation.error instanceof SchemaUnsupportedOperation)
  }

  const derivationOnly = createDerivationEngine({
    derivation: { derive: () => Result.ok(source) }
  })
  const missingFields = derivationOnly.pick(source, { name: true })
  assert.equal(Result.isError(missingFields), true)
  if (Result.isError(missingFields)) {
    assert.ok(missingFields.error instanceof SchemaUnsupportedOperation)
  }
})

test('normalizes throwing, rejecting, and malformed providers', async () => {
  const throwing = createDerivationEngine({
    derivation: {
      derive: () => {
        throw new Error('boom')
      }
    }
  })
  const thrown = throwing.extend(source, { extra: nameField })
  assert.equal(Result.isError(thrown), true)
  if (Result.isError(thrown)) assert.ok(thrown.error instanceof SchemaExecutionFailure)

  const rejecting = createDerivationEngine({
    derivation: { derive: () => Promise.reject(new Error('later')) }
  })
  const rejected = rejecting.extend(source, { extra: nameField })
  assert.equal(Result.isError(rejected), true)
  if (Result.isError(rejected)) assert.ok(rejected.error instanceof SchemaAsyncRequired)
  await Promise.resolve()

  const malformed = createDerivationEngine({
    derivation: { derive: () => ({ value: source }) }
  })
  const malformedResult = malformed.extend(source, { extra: nameField })
  assert.equal(Result.isError(malformedResult), true)
  if (Result.isError(malformedResult))
    assert.ok(malformedResult.error instanceof SchemaDefinitionFailure)

  const hostileCapabilities = createDerivationEngine({
    get derivation() {
      throw new Error('capability getter failed')
    }
  })
  const capabilityFailure = hostileCapabilities.extend(source, { extra: nameField })
  assert.equal(Result.isError(capabilityFailure), true)
  if (Result.isError(capabilityFailure))
    assert.ok(capabilityFailure.error instanceof SchemaExecutionFailure)
})

test('memoizes deepPartial by schema identity and rejects cycles without overflowing', () => {
  const { calls, engine } = createFixture()
  const child = Object.freeze({ fields, refinement: 'child' })
  const root = { fields, refinement: 'root', child }
  const values = new Map()
  const memo = {
    has: (schema) => values.has(schema),
    get: (schema) => values.get(schema),
    set: (schema, derived) => values.set(schema, derived)
  }

  const first = engine.deepPartial(root, { memo })
  assert.equal(Result.isOk(first), true)
  const firstCallCount = calls.filter(([operation]) => operation === 'deepPartial').length
  const second = engine.deepPartial(root, { memo })
  assert.equal(Result.isOk(second), true)
  assert.equal(calls.filter(([operation]) => operation === 'deepPartial').length, firstCallCount)

  const cyclic = { fields }
  cyclic.child = cyclic
  const cycleResult = engine.deepPartial(cyclic)
  assert.equal(Result.isError(cycleResult), true)
  if (Result.isError(cycleResult))
    assert.ok(cycleResult.error instanceof SchemaUnsupportedOperation)

  const undefinedMemoValues = new Map()
  let undefinedCalls = 0
  const undefinedEngine = createDerivationEngine({
    derivation: {
      derive: () => {
        undefinedCalls += 1
        return Result.ok(undefined)
      }
    }
  })
  const undefinedMemo = {
    has: (schema) => undefinedMemoValues.has(schema),
    get: (schema) => undefinedMemoValues.get(schema),
    set: (schema, derived) => undefinedMemoValues.set(schema, derived)
  }
  assert.equal(Result.isOk(undefinedEngine.deepPartial(source, { memo: undefinedMemo })), true)
  assert.equal(Result.isOk(undefinedEngine.deepPartial(source, { memo: undefinedMemo })), true)
  assert.equal(undefinedCalls, 1)
})

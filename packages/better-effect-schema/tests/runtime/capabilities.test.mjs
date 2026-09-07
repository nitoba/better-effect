import assert from 'node:assert/strict'
import test from 'node:test'
import { Result } from 'better-result'

import { Schema, SchemaExecutionFailure } from '../../dist/esm/index.js'

test('Schema.with creates an immutable facade and mounts only implemented capabilities', () => {
  const adapter = {
    encoding: {
      encode(_schema, value) {
        return Result.ok({ encoded: value })
      }
    }
  }

  const local = Schema.with(adapter)

  assert.equal(Object.isFrozen(local), true)
  assert.equal(typeof local.decodeUnknown, 'function')
  assert.equal(typeof local.encode, 'function')
  assert.equal('derive' in local, false)
  assert.equal(Result.isOk(local.encode({}, 'value')), true)
})

test('Schema.with supports grouped capabilities without global provider state', () => {
  const calls = []
  const capability = {
    toJSONSchema(schema, options) {
      calls.push([schema, options])
      return Result.ok({ type: 'object' })
    }
  }

  const local = Schema.with({ capabilities: { jsonSchema: capability } })
  const schema = { '~standard': { version: 1, vendor: 'fixture', validate: () => ({ value: 1 }) } }
  const options = { target: 'draft-2020-12' }
  const result = local.toJSONSchema(schema, options)

  assert.equal(Result.isOk(result), true)
  assert.deepEqual(calls, [[schema, options]])
})

test('Schema.with normalizes throwing capability callbacks', () => {
  const local = Schema.with({
    encoding: {
      encode() {
        throw new Error('adapter failure')
      }
    }
  })

  const result = local.encode({}, 'value')

  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.ok(result.error instanceof SchemaExecutionFailure)
})

test('Schema.with turns malformed capability returns into Result failures', () => {
  const local = Schema.with({
    encoding: {
      encode() {
        return { value: 'not-a-result' }
      }
    }
  })

  const result = local.encode({}, 'value')

  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.ok(result.error instanceof SchemaExecutionFailure)
})

test('Schema.with reports missing capabilities through the runtime boundary', () => {
  const local = Schema.with({})
  const castFacade = local
  const result = castFacade.derive()

  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.equal(result.error._tag, 'SchemaUnsupportedOperation')
})

test('Schema.encode uses an explicit codec and its encoded projection exactly once', () => {
  let decodeCalls = 0
  let encodeCalls = 0
  let encodedValidationCalls = 0

  const schema = {
    '~standard': {
      version: 1,
      vendor: 'fixture',
      validate(value) {
        decodeCalls += 1
        return typeof value === 'string'
          ? { value: new Date(value) }
          : { issues: [{ message: 'Expected an ISO string' }] }
      }
    }
  }
  const encodedSchema = {
    '~standard': {
      version: 1,
      vendor: 'fixture',
      validate(value) {
        encodedValidationCalls += 1
        return typeof value === 'string' && value.endsWith('Z')
          ? { value: value.trim() }
          : { issues: [{ message: 'Expected an ISO representation' }] }
      }
    }
  }
  const codec = {
    schema,
    propsSchema: encodedSchema,
    encodedSchema,
    encode(value) {
      encodeCalls += 1
      return Result.ok(value.toISOString())
    }
  }

  const decoded = Schema.decode(schema, '2026-09-06T00:00:00.000Z')
  assert.equal(Result.isOk(decoded), true)
  assert.equal(decodeCalls, 1)

  const encoded = Schema.encode(codec, new Date('2026-09-06T00:00:00.000Z'))
  assert.equal(Result.isOk(encoded), true)
  if (Result.isOk(encoded)) assert.equal(encoded.value, '2026-09-06T00:00:00.000Z')
  assert.equal(encodeCalls, 1)
  assert.equal(encodedValidationCalls, 1)
  assert.equal(decodeCalls, 1)
})

test('Schema.encode does not invent an encoder for a read-only schema', () => {
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'fixture',
      validate(value) {
        return { value }
      }
    }
  }

  const result = Schema.encode(schema, 'value')

  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.equal(result.error._tag, 'SchemaUnsupportedOperation')
})

test('Schema.encode preserves explicit typed failures and captures throws', () => {
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'fixture',
      validate(value) {
        return { value }
      }
    }
  }
  const encodedSchema = schema
  const typedFailure = { _tag: 'EncodeRejected' }

  const rejected = Schema.encode(
    {
      schema,
      encodedSchema,
      encode() {
        return Result.err(typedFailure)
      }
    },
    'value'
  )
  assert.equal(Result.isError(rejected), true)
  if (Result.isError(rejected)) assert.equal(rejected.error, typedFailure)

  const thrown = new Error('encoder defect')
  const failed = Schema.encode(
    {
      schema,
      encodedSchema,
      encode() {
        throw thrown
      }
    },
    'value'
  )
  assert.equal(Result.isError(failed), true)
  if (Result.isError(failed)) {
    assert.equal(failed.error._tag, 'SchemaExecutionFailure')
    assert.equal(failed.error.cause, thrown)
  }
})

test('Schema.encode validates the produced representation and does not clone non-JSON values', () => {
  const representation = new Map([['answer', 42]])
  let encodedValidationCalls = 0
  const encodedSchema = {
    '~standard': {
      version: 1,
      vendor: 'fixture',
      validate(value) {
        encodedValidationCalls += 1
        return value instanceof Map ? { value } : { issues: [{ message: 'Expected a Map' }] }
      }
    }
  }
  const codec = {
    schema: encodedSchema,
    encodedSchema,
    encode() {
      return Result.ok(representation)
    }
  }

  const result = Schema.encode(codec, undefined)

  assert.equal(Result.isOk(result), true)
  if (Result.isOk(result)) assert.equal(result.value, representation)
  assert.equal(encodedValidationCalls, 1)
})

test('Schema.encodeAsync accepts sync and async callbacks, preserving rejection failures', async () => {
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'fixture',
      validate(value) {
        return { value }
      }
    }
  }
  const encodedSchema = schema
  let asyncCalls = 0

  const good = await Schema.encodeAsync(
    {
      schema,
      encodedSchema,
      encode() {
        return Result.ok('sync')
      },
      async encodeAsync() {
        asyncCalls += 1
        return Result.ok('async')
      }
    },
    'value'
  )
  assert.equal(Result.isOk(good), true)
  if (Result.isOk(good)) assert.equal(good.value, 'async')
  assert.equal(asyncCalls, 1)

  const rejection = new Error('late encoder rejection')
  const failed = await Schema.encodeAsync(
    {
      schema,
      encodedSchema,
      encodeAsync() {
        return Promise.reject(rejection)
      },
      encode() {
        return Result.ok('unused')
      }
    },
    'value'
  )
  assert.equal(Result.isError(failed), true)
  if (Result.isError(failed)) {
    assert.equal(failed.error._tag, 'SchemaExecutionFailure')
    assert.equal(failed.error.cause, rejection)
  }
})

test('sync encoding reports an async callback without executing it twice', async () => {
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'fixture',
      validate(value) {
        return { value }
      }
    }
  }
  let calls = 0
  const rejection = new Error('sync async rejection')
  const promise = Promise.resolve().then(() => {
    calls += 1
    return Promise.reject(rejection)
  })
  const codec = {
    schema,
    encodedSchema: schema,
    encode() {
      return promise
    }
  }

  const result = Schema.encode(codec, 'value')
  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.equal(result.error._tag, 'SchemaAsyncRequired')
  await promise.catch(() => undefined)
  await Promise.resolve()
  assert.equal(calls, 1)
})

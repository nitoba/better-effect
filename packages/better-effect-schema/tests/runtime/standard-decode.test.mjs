import assert from 'node:assert/strict'
import test from 'node:test'
import { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure
} from '../../dist/esm/index.js'

const makeSchema = (validate, identifier = 'StandardFixture') => ({
  identifier,
  '~standard': {
    version: 1,
    vendor: 'fixture',
    validate
  }
})

test('decodes Standard Schema values without provider-specific inspection', () => {
  let calls = 0
  let receiver
  let receivedOptions
  const options = { libraryOptions: { fixture: true } }
  const schema = makeSchema(function (value, optionsArgument) {
    calls += 1
    receiver = this
    receivedOptions = optionsArgument
    return { value: { id: value.id.toUpperCase() }, issues: undefined }
  })

  const result = Schema.decodeUnknown(schema, { id: 'user-1' }, options)

  assert.equal(Result.isOk(result), true)
  if (Result.isOk(result)) assert.deepEqual(result.value, { id: 'USER-1' })
  assert.equal(calls, 1)
  assert.equal(receiver, schema['~standard'])
  assert.equal(receivedOptions, options)
})

test('preserves falsy successful values and treats empty issues as failure', () => {
  for (const value of [undefined, null, false, 0, '']) {
    const schema = makeSchema(() => ({ value, issues: undefined }))
    const result = Schema.decodeUnknown(schema, 'input')

    assert.equal(Result.isOk(result), true)
    if (Result.isOk(result)) assert.equal(result.value, value)
  }

  const failed = Schema.decodeUnknown(
    makeSchema(() => ({ issues: [] })),
    'input'
  )
  assert.equal(Result.isError(failed), true)
  if (Result.isError(failed)) assert.ok(failed.error instanceof SchemaDecodeFailure)
})

test('normalizes Standard Schema issue paths and malformed protocols', () => {
  const failed = Schema.decodeUnknown(
    makeSchema(() => ({
      issues: [
        {
          message: 'provider detail',
          path: ['user', { key: Symbol('id') }, Symbol('tail')]
        }
      ]
    })),
    'input'
  )

  assert.equal(Result.isError(failed), true)
  if (Result.isError(failed)) {
    assert.ok(failed.error instanceof SchemaDecodeFailure)
    assert.deepEqual(failed.error.issues[0].path, ['user', '[symbol]', '[symbol]'])
  }

  const malformed = Schema.decodeUnknown(
    { '~standard': { version: 2, vendor: 'fixture' } },
    'input'
  )
  assert.equal(Result.isError(malformed), true)
  if (Result.isError(malformed)) assert.ok(malformed.error instanceof SchemaDefinitionFailure)
})

test('captures async validation in the sync API and does not invoke it twice', () => {
  let calls = 0
  const schema = makeSchema(async () => {
    calls += 1
    return { value: 'done', issues: undefined }
  })

  const result = Schema.decodeUnknown(schema, 'input')

  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.ok(result.error instanceof SchemaAsyncRequired)
  assert.equal(calls, 1)
})

test('awaits successful validation and captures later rejection', async () => {
  const good = await Schema.decodeUnknownAsync(
    makeSchema(async () => ({ value: 'done', issues: undefined })),
    'input'
  )
  assert.equal(Result.isOk(good), true)

  const bad = await Schema.decodeUnknownAsync(
    makeSchema(async () => {
      throw new Error('provider failure')
    }),
    'input'
  )
  assert.equal(Result.isError(bad), true)
  if (Result.isError(bad)) assert.ok(bad.error instanceof SchemaExecutionFailure)
})

test('captures throwing protocol getters as execution failures', () => {
  const schema = {
    get '~standard'() {
      throw new Error('protocol getter failure')
    }
  }

  const result = Schema.decodeUnknown(schema, 'input')

  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.ok(result.error instanceof SchemaExecutionFailure)
})

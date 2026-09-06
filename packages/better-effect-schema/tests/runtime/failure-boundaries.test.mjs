import assert from 'node:assert/strict'
import test from 'node:test'
import * as z from 'zod'
import { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../dist/esm/index.js'

test('failure taxonomy preserves causes without serializing them', () => {
  const cause = Object.create(null)
  cause.self = cause
  cause.secret = 'must stay private'

  const failures = [
    new SchemaDefinitionFailure({ identifier: 'Definition', cause }),
    new SchemaExecutionFailure({ identifier: 'Execution', operation: 'run', cause }),
    new SchemaUnsupportedOperation({ identifier: 'Unsupported', operation: 'json', cause }),
    new SchemaAsyncRequired({ identifier: 'Async', operation: 'decode', cause })
  ]

  for (const failure of failures) {
    assert.equal(failure.cause, cause)
    assert.equal(Object.prototype.propertyIsEnumerable.call(failure, 'cause'), false)
    assert.equal('cause' in failure.toJSON(), false)
    assert.equal('stack' in failure.toJSON(), false)
    assert.doesNotThrow(() => JSON.stringify(failure))
  }
})

test('unexpected synchronous provider errors become SchemaExecutionFailure', () => {
  const Broken = new Proxy(z.string(), {
    get(target, property, receiver) {
      if (property === '_zod') throw new Error('provider exploded')
      return Reflect.get(target, property, receiver)
    }
  })

  const result = Schema.decodeUnknown(Broken)('value')

  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) {
    assert.ok(result.error instanceof SchemaExecutionFailure)
    assert.equal(result.error.operation, 'decodeUnknown')
  }
})

test('the synchronous API reports an async schema without retrying it', () => {
  let checks = 0
  const AsyncSchema = z.string().superRefine(async () => {
    checks += 1
  })

  const result = Schema.decodeUnknown(AsyncSchema)('value')

  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.ok(result.error instanceof SchemaAsyncRequired)
  assert.equal(checks, 1)
})

test('unexpected asynchronous provider errors become SchemaExecutionFailure', async () => {
  const Broken = new Proxy(z.string(), {
    get(target, property, receiver) {
      if (property === '_zod') throw new Error('async provider exploded')
      return Reflect.get(target, property, receiver)
    }
  })

  const result = await Schema.decodeUnknownAsync(Broken)('value')

  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) {
    assert.ok(result.error instanceof SchemaExecutionFailure)
    assert.equal(result.error.operation, 'decodeUnknownAsync')
  }
})

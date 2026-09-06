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

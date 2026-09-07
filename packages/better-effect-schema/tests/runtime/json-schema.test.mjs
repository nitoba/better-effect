import assert from 'node:assert/strict'
import test from 'node:test'
import { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../dist/esm/index.js'
import {
  createSchemaMetadata,
  freezeSchemaAnnotations,
  mergeSchemaAnnotations,
  toJSONSchema
} from '../../dist/esm/json-schema/index.js'

const makeStandardJSONSchema = (input, output = input) => ({
  '~standard': {
    version: 1,
    vendor: 'portable-fixture',
    jsonSchema: { input, output }
  }
})

const expectFailure = (result, Failure) => {
  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.ok(result.error instanceof Failure)
}

test('consumes Standard JSON Schema without requiring validate', () => {
  const libraryOptions = { refs: 'preserve' }
  const calls = []
  const schema = makeStandardJSONSchema((options) => {
    calls.push(options)
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/User',
      $defs: {
        User: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    }
  })

  const result = Schema.toJSONSchema(schema, {
    side: 'input',
    target: 'draft-2020-12',
    libraryOptions
  })

  assert.equal(Result.isOk(result), true)
  if (Result.isOk(result)) {
    assert.equal(result.value.$ref, '#/$defs/User')
    assert.deepEqual(result.value.$defs.User.required, ['id'])
  }
  assert.deepEqual(calls, [{ target: 'draft-2020-12', libraryOptions }])
})

test('selects input and output independently and forwards options unchanged', () => {
  const calls = []
  const schema = makeStandardJSONSchema(
    (options) => {
      calls.push(['input', options])
      return { type: 'string' }
    },
    (options) => {
      calls.push(['output', options])
      return { type: 'integer' }
    }
  )

  const input = toJSONSchema(schema, { side: 'input', target: 'draft-07' })
  const output = toJSONSchema(schema, { side: 'output', target: 'draft-07' })

  assert.deepEqual(input, Result.ok({ type: 'string' }))
  assert.deepEqual(output, Result.ok({ type: 'integer' }))
  assert.deepEqual(calls, [
    ['input', { target: 'draft-07' }],
    ['output', { target: 'draft-07' }]
  ])
})

test('accepts an explicit JSON Schema capability without a Standard validator', () => {
  const model = {
    jsonSchema: {
      input: () => ({ type: 'string', title: 'Wire value' }),
      output: () => ({ type: 'number', title: 'Domain value' })
    }
  }

  const result = toJSONSchema(model, { target: 'openapi-3.0' })

  assert.deepEqual(result, Result.ok({ type: 'string', title: 'Wire value' }))
})

test('rejects invalid options, missing converters, and malformed documents', () => {
  const schema = makeStandardJSONSchema(() => ({}))
  expectFailure(toJSONSchema(schema, { target: '' }), SchemaUnsupportedOperation)
  expectFailure(
    toJSONSchema(schema, { side: 'wire', target: 'draft-07' }),
    SchemaUnsupportedOperation
  )
  expectFailure(
    toJSONSchema(
      makeStandardJSONSchema(() => true),
      { target: 'draft-07' }
    ),
    SchemaDefinitionFailure
  )
  expectFailure(toJSONSchema(schema, { target: 'draft-07' }), SchemaDefinitionFailure)
  expectFailure(
    toJSONSchema(
      makeStandardJSONSchema(() => ({ type: 123 })),
      { target: 'draft-07' }
    ),
    SchemaDefinitionFailure
  )
  expectFailure(
    toJSONSchema(
      makeStandardJSONSchema(() => ({ type: 'string', default: new Date() })),
      { target: 'draft-07' }
    ),
    SchemaDefinitionFailure
  )
  expectFailure(
    toJSONSchema(
      makeStandardJSONSchema(() => ({ type: 'integer', default: 1n })),
      { target: 'draft-07' }
    ),
    SchemaDefinitionFailure
  )
  expectFailure(
    toJSONSchema(
      makeStandardJSONSchema(() => ({
        $id: 'urn:duplicate',
        $defs: { nested: { $id: 'urn:duplicate', type: 'string' } }
      })),
      { target: 'draft-07' }
    ),
    SchemaDefinitionFailure
  )
})

test('captures protocol getters, converter failures, and output getters', () => {
  const sourceFailure = new Error('standard access failed')
  const source = {
    get '~standard'() {
      throw sourceFailure
    }
  }
  expectFailure(toJSONSchema(source, { target: 'draft-07' }), SchemaExecutionFailure)

  const converterFailure = new Error('converter failed')
  const converter = makeStandardJSONSchema(() => {
    throw converterFailure
  })
  expectFailure(toJSONSchema(converter, { target: 'draft-07' }), SchemaExecutionFailure)

  const documentFailure = new Error('document getter failed')
  const output = {
    type: 'object',
    get properties() {
      throw documentFailure
    }
  }
  expectFailure(
    toJSONSchema(
      makeStandardJSONSchema(() => output),
      { target: 'draft-07' }
    ),
    SchemaExecutionFailure
  )
})

test('reports an unexpectedly asynchronous converter without leaking its rejection', async () => {
  const result = toJSONSchema(
    makeStandardJSONSchema(() => Promise.reject(new Error('late failure'))),
    { target: 'draft-07' }
  )

  expectFailure(result, SchemaAsyncRequired)
  await Promise.resolve()
})

test('portable metadata is local, copied, and immutable', () => {
  const annotations = {
    title: 'User',
    examples: [{ id: 1 }]
  }
  const frozen = freezeSchemaAnnotations(annotations)
  const metadata = createSchemaMetadata('User', annotations)
  const merged = mergeSchemaAnnotations(frozen, { description: 'A user' })

  assert.notEqual(frozen, annotations)
  assert.equal(Object.isFrozen(frozen), true)
  assert.equal(Object.isFrozen(frozen.examples), true)
  assert.equal(Object.isFrozen(metadata), true)
  assert.equal(metadata.identifier, 'User')
  assert.deepEqual(merged, {
    title: 'User',
    examples: [{ id: 1 }],
    description: 'A user'
  })
  annotations.title = 'Mutated outside the metadata'
  assert.equal(frozen.title, 'User')
})

test('does not inspect or execute a validator while converting', () => {
  let validatorReads = 0
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'portable-fixture',
      get validate() {
        validatorReads += 1
        throw new Error('validate must not be read')
      },
      jsonSchema: {
        input: () => ({ type: 'string' }),
        output: () => ({ type: 'string' })
      }
    }
  }

  const result = toJSONSchema(schema, { target: 'draft-2020-12' })

  assert.equal(Result.isOk(result), true)
  assert.equal(validatorReads, 0)
})

test('normalizes documents without mutating the converter result', () => {
  const document = {
    $defs: { User: { type: 'object' } },
    $ref: '#/$defs/User'
  }

  const result = toJSONSchema(
    makeStandardJSONSchema(() => document),
    {
      target: 'draft-2020-12'
    }
  )

  assert.equal(Result.isOk(result), true)
  assert.notEqual(Result.isOk(result) ? result.value : undefined, document)
  assert.deepEqual(document, {
    $defs: { User: { type: 'object' } },
    $ref: '#/$defs/User'
  })
})

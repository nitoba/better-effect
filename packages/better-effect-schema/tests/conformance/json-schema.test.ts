import { describe, expect, test } from 'bun:test'
import { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../dist/esm/index.js'
import { expectFailure, noThrowSync, standardSchema, unwrapOk } from './helpers.js'

const document = {
  $id: 'https://example.test/schemas/user',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'User',
  description: 'Conformance user schema',
  $defs: {
    User: {
      $ref: '#/$defs/User'
    }
  },
  type: 'object',
  properties: {
    id: { type: 'string' }
  },
  required: ['id']
}

describe('provider-neutral Standard JSON Schema consumer', () => {
  test('consumes JSON Schema without requiring validate and forwards side/options', () => {
    const calls: unknown[] = []
    const source = {
      '~standard': {
        version: 1,
        vendor: 'json-schema-fixture',
        jsonSchema: {
          input(options: unknown) {
            calls.push(['input', options])
            return structuredClone(document)
          },
          output(options: unknown) {
            calls.push(['output', options])
            return structuredClone(document)
          }
        }
      }
    }

    const input = noThrowSync(() =>
      Schema.toJSONSchema(source, {
        side: 'input',
        target: 'draft-2020-12',
        libraryOptions: { source: 'input' }
      })
    )
    const output = noThrowSync(() =>
      Schema.toJSONSchema(source, {
        side: 'output',
        target: 'draft-2020-12',
        libraryOptions: { source: 'output' }
      })
    )

    expect(Result.isOk(input)).toBe(true)
    expect(Result.isOk(output)).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual([
      'input',
      { target: 'draft-2020-12', libraryOptions: { source: 'input' } }
    ])
    expect(calls[1]).toEqual([
      'output',
      { target: 'draft-2020-12', libraryOptions: { source: 'output' } }
    ])
    expect(unwrapOk(input)).toEqual(document)
    expect(unwrapOk(output)).toEqual(document)
  })

  test('accepts the explicit JSONSchemaModel shape and preserves source data', () => {
    const source = {
      jsonSchema: {
        input: () => document,
        output: () => document
      }
    }
    const before = JSON.stringify(source)
    const result = noThrowSync(() =>
      Schema.toJSONSchema(source, {
        target: 'draft-2020-12'
      })
    )
    expect(unwrapOk(result)).toEqual(document)
    expect(JSON.stringify(source)).toBe(before)
  })

  test('rejects malformed documents, targets, async converters, and throwing getters', () => {
    const malformed = noThrowSync(() =>
      Schema.toJSONSchema(
        {
          jsonSchema: { input: () => ({}) }
        },
        { target: 'draft-2020-12' }
      )
    )
    expectFailure(malformed, SchemaDefinitionFailure)

    const invalidTarget = noThrowSync(() =>
      Schema.toJSONSchema(
        {
          jsonSchema: { input: () => document }
        },
        { target: '' }
      )
    )
    expectFailure(invalidTarget, SchemaUnsupportedOperation)

    const asyncDocument = noThrowSync(() =>
      Schema.toJSONSchema(
        {
          jsonSchema: { input: () => Promise.resolve(document) }
        },
        { target: 'draft-2020-12' }
      )
    )
    expectFailure(asyncDocument as never, SchemaAsyncRequired)

    const hostile = {
      get jsonSchema(): never {
        throw new Error('json-schema-secret')
      }
    }
    const thrown = noThrowSync(() => Schema.toJSONSchema(hostile, { target: 'draft-2020-12' }))
    const execution = expectFailure(thrown, SchemaExecutionFailure)
    expect(JSON.stringify(execution)).not.toContain('json-schema-secret')
  })

  test('rejects cyclic and non-JSON converter output without throwing', () => {
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic.self = cyclic
    const cyclicResult = noThrowSync(() =>
      Schema.toJSONSchema({ jsonSchema: { input: () => cyclic } }, { target: 'draft-2020-12' })
    )
    expectFailure(cyclicResult, SchemaDefinitionFailure)

    const bigintResult = noThrowSync(() =>
      Schema.toJSONSchema(
        { jsonSchema: { input: () => ({ type: 'integer', minimum: 1n }) } },
        { target: 'draft-2020-12' }
      )
    )
    expectFailure(bigintResult, SchemaDefinitionFailure)
  })

  test('does not execute validation or construct instances while converting', () => {
    let validationCalls = 0
    const source = standardSchema(() => {
      validationCalls += 1
      return { value: 'never-used' }
    })
    const result = noThrowSync(() =>
      Schema.toJSONSchema(
        {
          '~standard': {
            version: 1,
            vendor: 'json-schema-no-validate',
            jsonSchema: { input: () => document, output: () => document }
          },
          source
        },
        { target: 'draft-2020-12' }
      )
    )

    expect(Result.isOk(result)).toBe(true)
    expect(validationCalls).toBe(0)
  })
})

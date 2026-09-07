import { describe, expect, test } from 'bun:test'
import { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure
} from '../../dist/esm/index.js'
import {
  expectFailure,
  noThrowAsync,
  noThrowSync,
  standardIssue,
  standardSchema,
  unwrapOk
} from './helpers.js'

describe('minimal Standard Schema contract', () => {
  test('supports typed and unknown data-first/data-last decode forms', () => {
    let calls = 0
    let receivedOptions: unknown
    const options = { libraryOptions: { trace: true } }
    const schema = standardSchema<{ readonly id: string }, { readonly id: number }>(
      (value, optionsArgument) => {
        calls += 1
        receivedOptions = optionsArgument
        if (typeof value !== 'object' || value === null || typeof value.id !== 'string') {
          return { issues: [standardIssue('Expected an id')] }
        }
        return { value: { id: Number(value.id) } }
      }
    )

    expect(unwrapOk(Schema.decode(schema)({ id: '42' }, options))).toEqual({ id: 42 })
    expect(unwrapOk(Schema.decode(schema, { id: '7' }, options))).toEqual({ id: 7 })
    expect(unwrapOk(Schema.decodeUnknown(schema, { id: '8' }, options))).toEqual({ id: 8 })
    expect(calls).toBe(3)
    expect(receivedOptions).toBe(options)
  })

  test('preserves undefined, null, false, zero, and empty string successes', () => {
    for (const value of [undefined, null, false, 0, '']) {
      const schema = standardSchema<unknown, typeof value>(() => ({ value }))
      const result = noThrowSync(() => Schema.decodeUnknown(schema, 'input'))
      expect(Result.isOk(result)).toBe(true)
      if (Result.isOk(result)) expect(result.value).toBe(value)
    }
  })

  test('turns malformed definitions, issues, and thrown protocol access into typed errors', () => {
    const invalidIssue = standardSchema(() => ({ issues: [] }))
    expectFailure(Schema.decodeUnknown(invalidIssue, 'value'), SchemaDecodeFailure)

    const malformed = { '~standard': { version: 2, vendor: 'fixture' } }
    expectFailure(Schema.decodeUnknown(malformed, 'value'), SchemaDefinitionFailure)

    const hostile = {
      get '~standard'(): never {
        throw new Error('hostile protocol getter')
      }
    }
    expectFailure(Schema.decodeUnknown(hostile, 'value'), SchemaExecutionFailure)
  })

  test('detects async validation once and observes later rejection', async () => {
    let calls = 0
    const rejection = new Error('validation rejected')
    const schema = standardSchema(async () => {
      calls += 1
      throw rejection
    })

    const sync = noThrowSync(() => Schema.decodeUnknown(schema, 'value'))
    expectFailure(sync, SchemaAsyncRequired)
    expect(calls).toBe(1)

    const asyncResult = await noThrowAsync(() => Schema.decodeUnknownAsync(schema, 'value'))
    const error = expectFailure(asyncResult, SchemaExecutionFailure)
    expect(error.cause).toBe(rejection)
    expect(calls).toBe(2)
  })

  test('observes hostile thenables without throwing or leaking an unhandled rejection', () => {
    const thenable = Object.defineProperty({}, 'then', {
      get() {
        throw new Error('thenable secret')
      }
    })
    const result = noThrowSync(() =>
      Schema.decodeUnknown(
        standardSchema(() => thenable),
        'value'
      )
    )
    const error = expectFailure(result, SchemaExecutionFailure)
    expect(JSON.stringify(error)).not.toContain('thenable secret')
  })

  test('normalizes unsafe issue paths without exposing rejected input', () => {
    const secret = 'do-not-leak'
    const result = noThrowSync(() =>
      Schema.decodeUnknown(
        standardSchema(() => ({
          issues: [
            standardIssue('invalid', [
              'user',
              0,
              Symbol('secret'),
              { toString: () => secret } as unknown as string
            ])
          ]
        })),
        { secret }
      )
    )
    const error = expectFailure(result, SchemaDecodeFailure)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(error.issues[0]?.path).toEqual(['user', 0, '[symbol]'])
  })
})

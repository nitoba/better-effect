import { describe, expect, test } from 'bun:test'
import { Effect } from 'better-effect'
import { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaDecodeFailure,
  SchemaEncodeFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../dist/esm/index.js'
import {
  expectFailure,
  noThrowAsync,
  noThrowSync,
  standardIssue,
  standardSchema,
  unwrapErr,
  unwrapOk
} from './helpers.js'

const stringInput = standardSchema<string, Date>((value) => {
  if (typeof value !== 'string') return { issues: [standardIssue('Expected a string')] }
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? { issues: [standardIssue('Expected an ISO date')] }
    : { value: date }
})

const dateOutput = standardSchema<Date, Date>((value) =>
  value instanceof Date ? { value } : { issues: [standardIssue('Expected a Date')] }
)

const encodedOutput = standardSchema<string, string>((value) =>
  typeof value === 'string' && value.endsWith('Z')
    ? { value }
    : { issues: [standardIssue('Expected an ISO representation')] }
)

const dateCodec = {
  identifier: 'ConformanceDateCodec',
  schema: stringInput,
  propsSchema: dateOutput,
  encodedSchema: encodedOutput,
  encode(value: Date) {
    return Result.ok(value.toISOString())
  }
}

describe('provider-neutral codecs', () => {
  test('keeps input, props, output, and encoded representations distinct', () => {
    let encodeCalls = 0
    let encodedValidationCalls = 0
    const codec = {
      ...dateCodec,
      encodedSchema: standardSchema<string, string>((value) => {
        encodedValidationCalls += 1
        return encodedOutput['~standard'].validate(value)
      }),
      encode(value: Date) {
        encodeCalls += 1
        return Result.ok(value.toISOString())
      }
    }

    const decoded = noThrowSync(() => Schema.decode(codec.schema, '2026-09-06T00:00:00.000Z'))
    expect(unwrapOk(decoded)).toBeInstanceOf(Date)

    const encoded = noThrowSync(() => Schema.encode(codec, new Date('2026-09-06T00:00:00.000Z')))
    expect(unwrapOk(encoded)).toBe('2026-09-06T00:00:00.000Z')
    expect(encodeCalls).toBe(1)
    expect(encodedValidationCalls).toBe(1)
  })

  test('preserves explicit failures and normalizes malformed or throwing encoders', () => {
    const domainFailure = { _tag: 'DomainEncodeFailure' }
    const rejected = noThrowSync(() =>
      Schema.encode({ ...dateCodec, encode: () => Result.err(domainFailure) }, new Date())
    )
    expect(unwrapErr(rejected)).toBe(domainFailure)
  })

  test('returns typed errors for invalid encoded representations and defects', () => {
    const invalid = noThrowSync(() =>
      Schema.encode(
        {
          ...dateCodec,
          encode: () => Result.ok('not-an-iso-date')
        },
        new Date()
      )
    )
    expectFailure(invalid, SchemaEncodeFailure)

    const thrown = new Error('encoder secret')
    const failed = noThrowSync(() =>
      Schema.encode(
        {
          ...dateCodec,
          encode: () => {
            throw thrown
          }
        },
        new Date()
      )
    )
    const execution = expectFailure(failed, SchemaExecutionFailure)
    expect(execution.cause).toBe(thrown)
    expect(JSON.stringify(execution)).not.toContain('encoder secret')
  })

  test('reports async encoders once and uses the async variant without duplication', async () => {
    let calls = 0
    const asyncCodec = {
      ...dateCodec,
      encode() {
        calls += 1
        return Promise.resolve(Result.ok('2026-09-06T00:00:00.000Z'))
      }
    }

    const sync = noThrowSync(() => Schema.encode(asyncCodec, new Date()))
    expectFailure(sync, SchemaAsyncRequired)
    expect(calls).toBe(1)

    const asyncResult = await noThrowAsync(() => Schema.encodeAsync(asyncCodec, new Date()))
    expect(unwrapOk(asyncResult)).toBe('2026-09-06T00:00:00.000Z')
    expect(calls).toBe(2)
  })

  test('rejects codecs without an explicit encoder instead of inventing an inverse', () => {
    const result = noThrowSync(() => Schema.encode({ schema: stringInput }, new Date()))
    expectFailure(result as never, SchemaUnsupportedOperation)
  })
})

describe('Result.gen and Effect.fn integration', () => {
  test('composes schema effects without creating a Runtime', () => {
    const program = Effect.fn(function* () {
      const user = yield* Schema.decodeUnknown(
        standardSchema(() => ({ value: { id: 'user-1' } })),
        undefined
      )
      return Result.ok({ user, marker: 'effect' })
    })

    const result = noThrowSync(() => program())
    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result))
      expect(result.value).toEqual({ user: { id: 'user-1' }, marker: 'effect' })
  })

  test('short-circuits the exact schema failure through Result.gen', () => {
    const failure = noThrowSync(() =>
      Schema.decodeUnknown(
        standardSchema(() => ({ issues: [standardIssue('invalid')] })),
        undefined
      )
    )
    const result = noThrowSync(() =>
      Result.gen(function* () {
        const value = yield* failure
        return Result.ok(value)
      })
    )
    expectFailure(result, SchemaDecodeFailure)
  })

  test('async Effect.fn keeps the protocol result and failure boundary', async () => {
    const program = Effect.fn(async function* () {
      const value = yield* Result.await(
        Schema.decodeUnknownAsync(
          standardSchema(async () => ({ value: 'async-value' })),
          undefined
        )
      )
      return Result.ok(value)
    })

    const result = await noThrowAsync(() => program())
    expect(unwrapOk(result)).toBe('async-value')
  })
})

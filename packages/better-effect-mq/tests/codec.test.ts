// oxlint-disable anti-slop/no-shape-in-symbol-names -- result fixtures use structural test names.
// oxlint-disable anti-slop/no-unknown-parameters -- tests deliberately exercise untyped codec boundaries.
// oxlint-disable anti-slop/no-known-value-widening -- test fixtures preserve hostile values for runtime checks.
// oxlint-disable anti-slop/no-chained-type-assertions -- hostile-value fixtures intentionally bypass static typing.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test casts document runtime boundary cases.
// oxlint-disable anti-slop/no-runtime-typeof -- Standard Schema fixtures model untyped validators.

import { expect, test } from 'bun:test'
import { Result, type StandardSchemaV1 } from 'better-result'

import { Codec, JobCodecFailure, JobDecodeFailure, JobEncodeFailure } from '../src'

const issue = (
  message: string,
  path: readonly (PropertyKey | StandardSchemaV1.PathSegment)[],
  code: string
) => ({
  message,
  path,
  code
})

type ResultShape = {
  readonly status: 'ok' | 'error'
  readonly value?: unknown
}

const expectOk = (result: ResultShape, expected: unknown): void => {
  expect(result.status).toBe('ok')

  if (result.status === 'ok') {
    expect(result.value).toEqual(expected)
  }
}

test('primitive and void codecs use stable JSON representations', async () => {
  expectOk(await Promise.resolve(Codec.string.encode('hello')), 'hello')
  expectOk(await Promise.resolve(Codec.string.decode('hello')), 'hello')
  expectOk(await Promise.resolve(Codec.number.encode(42)), 42)
  expectOk(await Promise.resolve(Codec.boolean.decode(false)), false)
  expectOk(await Promise.resolve(Codec.void.encode(undefined)), null)
  expectOk(await Promise.resolve(Codec.void.decode(null)), undefined)

  const invalid = await Promise.resolve(Codec.string.decode(42))
  expect(Result.isError(invalid)).toBe(true)
  if (Result.isError(invalid)) {
    expect(JobDecodeFailure.is(invalid.error)).toBe(true)
    expect(invalid.error.code).toBe('invalid-type')
  }
})

test('JSON codec validates nested values without cloning or serializing them', async () => {
  const value = { profile: { name: 'Ada' }, roles: ['reader'] as const }
  const codec = Codec.json<typeof value>()
  const encoded = await Promise.resolve(codec.encode(value))
  const decoded = await Promise.resolve(codec.decode(value))

  expectOk(encoded, value)
  expectOk(decoded, value)
  if (Result.isOk(decoded)) {
    expect(decoded.value).toBe(value)
  }
})

test('JSON codec rejects unsafe values and cycles without invoking accessors', async () => {
  class User {
    readonly name = 'Ada'
  }

  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  let accessed = false
  const accessor = {}
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get: () => {
      accessed = true
      return 'do-not-read'
    }
  })

  const unsafe: readonly unknown[] = [
    undefined,
    1n,
    Symbol('secret'),
    () => 'secret',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    new Date(),
    new Map(),
    new Set(),
    new Error('secret'),
    new User(),
    cyclic,
    accessor
  ]

  for (const value of unsafe) {
    const result = await Promise.resolve(Codec.json().decode(value))

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(JobDecodeFailure.is(result.error)).toBe(true)
      expect(JSON.stringify(result.error)).not.toContain('secret')
      expect(JSON.stringify(result.error)).not.toContain('stack')
      expect(JSON.stringify(result.error)).not.toContain('cause')
    }
  }

  expect(accessed).toBe(false)
})

test('JSON codec safely accepts pollution-looking own keys', async () => {
  const value: unknown = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"token":"secret"}}'
  )
  const result = await Promise.resolve(Codec.json().decode(value))

  expect(Result.isOk(result)).toBe(true)
  expect('polluted' in Object.prototype).toBe(false)
  if (Result.isOk(result)) {
    expect(Object.prototype.hasOwnProperty.call(result.value, '__proto__')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(result.value, 'constructor')).toBe(true)
  }
})

test('JSON validation is iterative and rejects only beyond the documented depth', async () => {
  let value: unknown = null

  for (let index = 0; index <= 10_000; index += 1) {
    value = { child: value }
  }

  const result = await Promise.resolve(Codec.json().decode(value))

  expect(Result.isError(result)).toBe(true)
  if (Result.isError(result)) {
    expect(result.error.code).toBe('depth-limit')
  }
})

test('custom codec throws and rejections become redacted operation failures', async () => {
  const codec = Codec.make<string>({
    encode: () => {
      throw new Error('encode secret')
    },
    decode: async () => {
      throw new Error('decode secret')
    }
  })

  const encoded = await Promise.resolve(codec.encode('input secret'))
  const decoded = await Promise.resolve(codec.decode('persisted secret'))

  expect(Result.isError(encoded)).toBe(true)
  expect(Result.isError(decoded)).toBe(true)
  if (Result.isError(encoded) && Result.isError(decoded)) {
    expect(JobEncodeFailure.is(encoded.error)).toBe(true)
    expect(JobDecodeFailure.is(decoded.error)).toBe(true)
    expect(JSON.stringify(encoded.error)).not.toContain('secret')
    expect(JSON.stringify(decoded.error)).not.toContain('secret')
    expect(JSON.stringify(encoded.error)).not.toContain('stack')
    expect(JSON.stringify(decoded.error)).not.toContain('cause')
  }
})

test('custom callbacks normalize typed Result failures without leaking causes', async () => {
  const encodeFailure = new JobEncodeFailure({ message: 'encode failed', code: 'custom' })
  const decodeFailure = new JobDecodeFailure({ message: 'decode failed', code: 'custom' })
  const codec = Codec.make<string>({
    encode: () => Result.err(encodeFailure),
    decode: () => Result.err(decodeFailure)
  })

  const encoded = await Promise.resolve(codec.encode('input'))
  const decoded = await Promise.resolve(codec.decode('persisted'))

  expect(Result.isError(encoded)).toBe(true)
  expect(Result.isError(decoded)).toBe(true)
  if (Result.isError(encoded) && Result.isError(decoded)) {
    expect(encoded.error).not.toBe(encodeFailure)
    expect(decoded.error).not.toBe(decodeFailure)
    expect(encoded.error.code).toBe('custom')
    expect(decoded.error.code).toBe('custom')
    expect(JSON.stringify(encoded.error)).not.toContain('cause')
    expect(JSON.stringify(decoded.error)).not.toContain('cause')
  }
})

test('custom encoders cannot return non-JSON values across the boundary', async () => {
  const codec = Codec.make<Date>({
    // SAFETY: This deliberately bypasses the public callback type to exercise the runtime boundary.
    encode: (() => Result.ok(new Date())) as unknown as (
      value: Date
    ) => Result<import('../src').JsonValue, JobEncodeFailure>,
    decode: (value) => Result.ok(new Date(String(value)))
  })
  const result = await Promise.resolve(codec.encode(new Date()))

  expect(Result.isError(result)).toBe(true)
  if (Result.isError(result)) {
    expect(JobEncodeFailure.is(result.error)).toBe(true)
    expect(result.error.code).toBe('unsupported-object')
  }
})

test('Standard Schema supports sync and async validation with safe issues', async () => {
  type ParsedDate = Date
  type DateSchemaTypes = { input: string; output: ParsedDate }
  const dateSchema = {
    '~standard': {
      version: 1,
      vendor: 'codec-test',
      types: {} as DateSchemaTypes,
      validate(value: unknown): StandardSchemaV1.Result<ParsedDate> {
        if (typeof value !== 'string' || !value.endsWith('Z')) {
          return {
            issues: [
              issue(
                'invalid value: secret-input',
                [{ key: 'date' }, 0, { key: Symbol('secret') }],
                'date'
              )
            ]
          }
        }

        return { value: new Date(value) }
      }
    }
  } satisfies StandardSchemaV1<string, ParsedDate>
  const asyncSchema = {
    '~standard': {
      ...dateSchema['~standard'],
      validate: async (value: unknown) => dateSchema['~standard'].validate(value)
    }
  } satisfies StandardSchemaV1<string, ParsedDate>
  const codec = Codec.standardSchema({
    schema: dateSchema,
    encode: (value) => Result.ok(value.toISOString())
  })
  const asyncCodec = Codec.standardSchema({
    schema: asyncSchema,
    encode: async (value) => Result.ok(value.toISOString())
  })

  const decoded = await Promise.resolve(codec.decode('2025-01-01T00:00:00.000Z'))
  const encoded = await Promise.resolve(codec.encode(new Date('2025-01-01T00:00:00.000Z')))
  const asyncDecoded = await Promise.resolve(asyncCodec.decode('2025-01-01T00:00:00.000Z'))
  const failed = await Promise.resolve(codec.decode('invalid secret-input'))

  expect(Result.isOk(decoded)).toBe(true)
  expectOk(encoded, '2025-01-01T00:00:00.000Z')
  expect(Result.isOk(asyncDecoded)).toBe(true)
  expect(Result.isError(failed)).toBe(true)
  if (Result.isError(failed)) {
    expect(failed.error._tag).toBe('JobDecodeFailure')
    expect(failed.error.path).toEqual(['date', 0])
    expect(failed.error.issues?.[0]?.code).toBe('date')
    expect(JSON.stringify(failed.error)).not.toContain('secret-input')
  }
})

test('Standard Schema identity output is checked when no encode callback is supplied', async () => {
  type Value = { readonly count: number }
  type Types = { input: unknown; output: Value }
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'codec-json-test',
      types: {} as Types,
      validate: (value: unknown): StandardSchemaV1.Result<Value> => ({
        value: { count: typeof value === 'number' ? value : 0 }
      })
    }
  } satisfies StandardSchemaV1<unknown, Value>
  const codec = Codec.standardSchema({ schema })
  const result = await Promise.resolve(codec.decode(3))
  const encoded = await Promise.resolve(codec.encode({ count: 3 }))

  expectOk(result, { count: 3 })
  expectOk(encoded, { count: 3 })
})

test('old and new codec failures coexist and guards are tag based', () => {
  const oldFailure = new JobCodecFailure({ message: 'legacy' })
  const encodeFailure = new JobEncodeFailure({ message: 'encode' })
  const decodeFailure = new JobDecodeFailure({ message: 'decode' })
  const duplicateEncode = { _tag: 'JobEncodeFailure' }

  expect(JobCodecFailure.is(oldFailure)).toBe(true)
  expect(JobEncodeFailure.is(encodeFailure)).toBe(true)
  expect(JobDecodeFailure.is(decodeFailure)).toBe(true)
  expect(JobEncodeFailure.is(duplicateEncode)).toBe(true)
  expect(oldFailure._tag).toBe('JobCodecFailure')
  expect(encodeFailure._tag).toBe('JobEncodeFailure')
  expect(decodeFailure._tag).toBe('JobDecodeFailure')
})

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

test('primitive codecs round-trip every JSON primitive and void representation', async () => {
  const codec = Codec.json()

  for (const value of [null, 'hello', 42, false] as const) {
    const encoded = await Promise.resolve(codec.encode(value))

    expectOk(encoded, value)

    if (Result.isOk(encoded)) {
      expectOk(await Promise.resolve(codec.decode(encoded.value)), value)
    }
  }

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

test('JSON codec returns a detached, deeply frozen nested value', async () => {
  const value = { profile: { name: 'Ada' }, roles: ['reader'] as const }
  const codec = Codec.json<typeof value>()
  const encoded = await Promise.resolve(codec.encode(value))
  const decoded = await Promise.resolve(codec.decode(value))

  expectOk(encoded, value)
  expectOk(decoded, value)
  if (Result.isOk(decoded)) {
    expect(decoded.value).not.toBe(value)
    expect(Object.isFrozen(decoded.value)).toBe(true)
    expect(Object.isFrozen(decoded.value.profile)).toBe(true)
    expect(Object.isFrozen(decoded.value.roles)).toBe(true)
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

test('JSON codec materializes descriptor values instead of trusting a proxy', async () => {
  const target = { payload: 'target value' }
  const proxy = new Proxy(target, {
    get: (_source, key) => (key === 'payload' ? 1n : undefined),
    getOwnPropertyDescriptor: (source, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(source, key)

      return descriptor === undefined || key !== 'payload'
        ? descriptor
        : { ...descriptor, value: 'safe descriptor value' }
    }
  })
  const codec = Codec.json<{ readonly payload: string }>()
  const encoded = await Promise.resolve(codec.encode(proxy))
  const decoded = await Promise.resolve(codec.decode(proxy))

  expectOk(encoded, { payload: 'safe descriptor value' })
  expectOk(decoded, { payload: 'safe descriptor value' })
  if (Result.isOk(encoded)) {
    expect(encoded.value).not.toBe(proxy)
    if (typeof encoded.value === 'object' && encoded.value !== null && 'payload' in encoded.value) {
      expect(Object.isFrozen(encoded.value)).toBe(true)
      expect(typeof encoded.value.payload).toBe('string')
    }
  }
  if (Result.isOk(decoded)) {
    expect(decoded.value).not.toBe(proxy)
    expect(Object.isFrozen(decoded.value)).toBe(true)
    expect(typeof decoded.value.payload).toBe('string')
  }
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
  const schemaOutput: Value = { count: 3 }
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'codec-json-test',
      types: {} as Types,
      validate: (_value: unknown): StandardSchemaV1.Result<Value> => ({
        value: schemaOutput
      })
    }
  } satisfies StandardSchemaV1<unknown, Value>
  const codec = Codec.standardSchema({ schema })
  const result = await Promise.resolve(codec.decode(3))
  const encoded = await Promise.resolve(codec.encode({ count: 3 }))

  expectOk(result, { count: 3 })
  expectOk(encoded, { count: 3 })
  if (Result.isOk(result)) {
    expect(result.value).not.toBe(schemaOutput)
    expect(Object.isFrozen(result.value)).toBe(true)
  }
})

test('old and new codec versions coexist with distinct wire behavior', async () => {
  const oldCodec = Codec.make<{ readonly id: string }>({
    encode: (value) => Result.ok({ version: 1, id: value.id }),
    decode: (value) =>
      Result.ok({
        id:
          typeof value === 'object' && value !== null && 'id' in value
            ? String(value.id)
            : String(value)
      })
  })
  const newCodec = Codec.make<{ readonly id: string }>({
    encode: (value) => Result.ok({ version: 2, subject: value.id.toUpperCase() }),
    decode: (value) =>
      Result.ok({
        id:
          typeof value === 'object' && value !== null && 'subject' in value
            ? String(value.subject).toLowerCase()
            : String(value)
      })
  })
  const oldEncoded = await Promise.resolve(oldCodec.encode({ id: 'ada' }))
  const newEncoded = await Promise.resolve(newCodec.encode({ id: 'ada' }))

  expectOk(oldEncoded, { version: 1, id: 'ada' })
  expectOk(newEncoded, { version: 2, subject: 'ADA' })
  expect(oldEncoded).not.toEqual(newEncoded)
  if (Result.isOk(oldEncoded) && Result.isOk(newEncoded)) {
    expectOk(await Promise.resolve(oldCodec.decode(oldEncoded.value)), { id: 'ada' })
    expectOk(await Promise.resolve(newCodec.decode(newEncoded.value)), { id: 'ada' })
  }
})

test('tagged-error guards terminate on cyclic prototype and proxy chains', () => {
  let firstProxy: object
  let secondProxy: object
  firstProxy = new Proxy(Object.create(null), {
    getPrototypeOf: () => secondProxy
  })
  secondProxy = new Proxy(Object.create(null), {
    getPrototypeOf: () => firstProxy
  })

  expect(JobCodecFailure.is(firstProxy)).toBe(false)
  expect(JobEncodeFailure.is(secondProxy)).toBe(false)
})

test('tagged-error guards terminate on infinitely fresh prototype chains', () => {
  let prototypeInspections = 0
  const freshProxy = (): object =>
    new Proxy(Object.create(null), {
      getPrototypeOf: () => {
        prototypeInspections += 1
        return freshProxy()
      }
    })

  expect(JobEncodeFailure.is(freshProxy())).toBe(false)
  expect(prototypeInspections).toBe(32)
})

test('tagged-error guards remain tag based across package copies', () => {
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

import assert from 'node:assert/strict'
import test from 'node:test'
import * as z from 'zod'
import { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'

const Local = Schema.with(ZodAdapter)

const unwrap = (result) => {
  assert.equal(Result.isOk(result), true)
  return result.value
}

test('bridges Zod schemas and raw shapes without a global provider', () => {
  const object = z.object({ id: z.string() })
  assert.equal(unwrap(Local.bridge(object)), object)

  const raw = unwrap(Local.bridge({ id: z.string() }))
  assert.equal(raw instanceof z.ZodObject, true)
  assert.deepEqual(raw.parse({ id: 'one' }), { id: 'one' })

  const array = unwrap(Local.bridge(z.array(z.number())))
  assert.deepEqual(array.parse([1, 2]), [1, 2])

  const foreign = Local.bridge({ '~standard': { version: 1, vendor: 'foreign' } })
  assert.equal(Result.isError(foreign), true)
  if (Result.isError(foreign))
    assert.equal(foreign.error instanceof SchemaUnsupportedOperation, true)
})

test('keeps encoded and props projections distinct for object codecs', () => {
  const codec = z.codec(z.object({ external: z.string() }), z.object({ internal: z.number() }), {
    decode: ({ external }) => ({ internal: Number(external) }),
    encode: ({ internal }) => ({ external: String(internal) })
  })

  const encoded = unwrap(Local.encoded(codec))
  const props = unwrap(
    Local.props({
      schema: codec,
      propsSchema: z.object({ internal: z.number() }),
      construct: (value) => value
    })
  )

  assert.equal(encoded instanceof z.ZodObject, true)
  assert.deepEqual(encoded.parse({ external: '1' }), { external: '1' })
  assert.deepEqual(props.parse({ internal: 1 }), { internal: 1 })
  assert.equal(Result.isError(Local.fields(codec)), true)
  assert.equal(Result.isError(Local.derive(codec, 'pick', { internal: true })), true)
})

test('encodes only explicit Zod codecs and captures validation and callback failures', () => {
  let calls = 0
  const codec = z.codec(z.string(), z.date(), {
    decode: (value) => new Date(value),
    encode: (value) => {
      calls += 1
      return value.toISOString()
    }
  })

  const encoded = Local.encode(codec, new Date('2026-09-06T00:00:00.000Z'))
  assert.equal(unwrap(encoded), '2026-09-06T00:00:00.000Z')
  assert.equal(calls, 1)

  const invalidEncoded = z.codec(z.string(), z.date(), {
    decode: (value) => new Date(value),
    encode: () => 123
  })
  const invalid = Local.encode(invalidEncoded, new Date())
  assert.equal(Result.isError(invalid), true)
  if (Result.isError(invalid)) assert.equal(invalid.error instanceof SchemaExecutionFailure, true)

  const readOnly = z.string().transform((value) => value.length)
  const unsupported = Local.encode(readOnly, 4)
  assert.equal(Result.isError(unsupported), true)
  if (Result.isError(unsupported))
    assert.equal(unsupported.error instanceof SchemaUnsupportedOperation, true)

  const throwing = z.codec(z.string(), z.date(), {
    decode: (value) => new Date(value),
    encode: () => {
      throw new Error('encoder defect')
    }
  })
  const thrown = Local.encode(throwing, new Date())
  assert.equal(Result.isError(thrown), true)
  if (Result.isError(thrown)) assert.equal(thrown.error instanceof SchemaExecutionFailure, true)
})

test('captures async codec completion, sync async requirements, and rejection', async () => {
  const asyncCodec = z.codec(z.string(), z.date(), {
    decode: async (value) => new Date(value),
    encode: async (value) => value.toISOString()
  })

  const syncResult = Local.encode(asyncCodec, new Date())
  assert.equal(Result.isError(syncResult), true)
  if (Result.isError(syncResult))
    assert.equal(syncResult.error instanceof SchemaAsyncRequired, true)

  const asyncResult = await Local.encodeAsync(asyncCodec, new Date('2026-09-06T00:00:00.000Z'))
  assert.equal(unwrap(asyncResult), '2026-09-06T00:00:00.000Z')

  const rejecting = z.codec(z.string(), z.date(), {
    decode: (value) => new Date(value),
    encode: async () => {
      throw new Error('rejected encoder')
    }
  })
  const rejected = await Local.encodeAsync(rejecting, new Date())
  assert.equal(Result.isError(rejected), true)
  if (Result.isError(rejected)) assert.equal(rejected.error instanceof SchemaExecutionFailure, true)
})

test('supports safe object structure and derivations while preserving native policies', () => {
  const object = z.object({ id: z.string(), count: z.number() })
  const fields = unwrap(Local.fields(object))
  assert.equal(fields.id, object.shape.id)

  const extended = unwrap(Local.struct(object, { label: z.string() }))
  assert.deepEqual(extended.parse({ id: 'one', count: 1, label: 'One' }), {
    id: 'one',
    count: 1,
    label: 'One'
  })

  const picked = unwrap(Local.derive(object, 'pick', { id: true }))
  assert.deepEqual(picked.parse({ id: 'one' }), { id: 'one' })
  const omitted = unwrap(Local.derive(object, 'omit', { count: true }))
  assert.deepEqual(omitted.parse({ id: 'one' }), { id: 'one' })

  const partial = unwrap(Local.derive(object, 'partial'))
  assert.deepEqual(partial.parse({}), {})
  const exactPartial = unwrap(Local.derive(object, 'exactPartial'))
  assert.equal(exactPartial.safeParse({ id: undefined }).success, false)
  const required = unwrap(Local.derive(partial, 'required'))
  assert.equal(required.safeParse({}).success, false)

  const nested = z.object({ child: z.object({ id: z.string() }) })
  const deepPartial = unwrap(Local.derive(nested, 'deepPartial'))
  assert.deepEqual(deepPartial.parse({ child: {} }), { child: {} })

  const strict = unwrap(Local.policy(object, 'strict'))
  assert.equal(strict.safeParse({ id: 'one', count: 1, extra: true }).success, false)
  const loose = unwrap(Local.policy(object, 'loose'))
  assert.equal(loose.safeParse({ id: 'one', count: 1, extra: true }).success, true)
  const strip = unwrap(Local.policy(object, 'strip'))
  assert.deepEqual(strip.parse({ id: 'one', count: 1, extra: true }), { id: 'one', count: 1 })

  const catchall = Local.policy(object, 'catchall')
  assert.equal(Result.isError(catchall), true)
})

test('normalizes throwing refinements at the Standard Schema boundary', () => {
  const throwing = z.string().refine(() => {
    throw new Error('refinement defect')
  })
  const syncResult = Local.decodeUnknown(throwing, 'value')
  assert.equal(Result.isError(syncResult), true)
  if (Result.isError(syncResult)) {
    assert.equal(
      syncResult.error instanceof SchemaExecutionFailure ||
        syncResult.error instanceof SchemaAsyncRequired,
      true
    )
  }
})

import assert from 'node:assert/strict'
import { test } from 'bun:test'
import * as v from 'valibot'
import { Result } from 'better-result'

import { Schema, SchemaExecutionFailure, SchemaUnsupportedOperation } from '../../dist/esm/index.js'
import { ValibotAdapter } from '../../dist/esm/valibot.js'

const local = Schema.with(ValibotAdapter)

const unwrap = (result) => {
  assert.equal(Result.isOk(result), true)
  if (Result.isError(result)) throw result.error
  return result.value
}

const failureTag = (result, tag) => {
  assert.equal(Result.isError(result), true)
  if (Result.isError(result)) assert.equal(result.error._tag, tag)
}

test('Valibot subpath reads native schemas and bridges without revalidation', () => {
  const schema = v.object({ id: v.string() })

  assert.equal(unwrap(local.read(schema)), schema)
  assert.equal(unwrap(local.bridge(schema)), schema)
  failureTag(local.read({}), 'SchemaUnsupportedOperation')
  assert.equal('encode' in local, false)
  assert.equal('toJSONSchema' in local, false)
})

test('Valibot structural capabilities preserve native entries and policies', () => {
  const base = v.object({ id: v.string(), age: v.number() })
  const fields = unwrap(local.fields(base))

  assert.deepEqual(Object.keys(fields), ['id', 'age'])

  const extended = unwrap(local.struct(base, { ...fields, role: v.literal('admin') }))
  assert.deepEqual(v.safeParse(extended, { id: 'u1', age: 42, role: 'admin' }).output, {
    id: 'u1',
    age: 42,
    role: 'admin'
  })
  assert.equal(v.safeParse(extended, { id: 'u1', age: 42, role: 'user' }).success, false)

  const strict = unwrap(local.policy(base, 'strict'))
  const loose = unwrap(local.policy(base, 'loose'))
  const strip = unwrap(local.policy(base, 'strip'))
  assert.equal(v.safeParse(strict, { id: 'u1', age: 42, extra: true }).success, false)
  assert.deepEqual(v.safeParse(loose, { id: 'u1', age: 42, extra: true }).output, {
    id: 'u1',
    age: 42,
    extra: true
  })
  assert.deepEqual(v.safeParse(strip, { id: 'u1', age: 42, extra: true }).output, {
    id: 'u1',
    age: 42
  })

  const withRest = v.objectWithRest({ id: v.string() }, v.number())
  const catchall = unwrap(local.policy(withRest, 'catchall'))
  assert.deepEqual(v.safeParse(catchall, { id: 'u1', count: 2 }).output, {
    id: 'u1',
    count: 2
  })
  failureTag(local.policy(base, 'catchall'), 'SchemaUnsupportedOperation')
})

test('Valibot derivations map only supported operations and retain defaults', () => {
  const base = v.object({
    id: v.string(),
    name: v.optional(v.string(), 'Ada'),
    age: v.number()
  })

  const picked = unwrap(local.derive(base, 'pick', { id: true, name: true }))
  const omitted = unwrap(local.derive(base, 'omit', { age: true }))
  const partial = unwrap(local.derive(base, 'partial'))
  const exactPartial = unwrap(local.derive(base, 'exactPartial'))
  const required = unwrap(local.derive(partial, 'required'))
  const nested = v.object({ profile: v.object({ displayName: v.string() }) })
  const deep = unwrap(local.derive(nested, 'deepPartial'))

  assert.deepEqual(v.safeParse(picked, { id: 'u1' }).output, {
    id: 'u1',
    name: 'Ada'
  })
  assert.deepEqual(v.safeParse(omitted, { id: 'u1' }).output, { id: 'u1', name: 'Ada' })
  assert.equal(v.safeParse(partial, {}).success, true)
  assert.equal(v.safeParse(exactPartial, {}).success, true)
  assert.equal(v.safeParse(required, {}).success, false)
  assert.deepEqual(v.safeParse(deep, {}).output, {})
  assert.equal(v.safeParse(deep, { profile: {} }).success, true)

  const encoded = unwrap(local.encoded(base))
  assert.deepEqual(v.safeParse(encoded, { id: 'u1', age: 1 }).output, {
    id: 'u1',
    age: 1
  })
  assert.deepEqual(v.safeParse(base, { id: 'u1', age: 1 }).output, {
    id: 'u1',
    name: 'Ada',
    age: 1
  })
})

test('Valibot encoded projection preserves checks and rejects transforms', () => {
  const checked = v.object({
    id: v.pipe(v.string(), v.minLength(2))
  })
  const checkedEncoded = unwrap(local.encoded(checked))
  assert.equal(v.safeParse(checkedEncoded, { id: 'ok' }).success, true)
  assert.equal(v.safeParse(checkedEncoded, { id: '' }).success, false)

  const objectChecked = v.pipe(
    v.object({ id: v.string() }),
    v.check((value) => value.id.startsWith('u'))
  )
  const checkedInput = unwrap(local.encoded(objectChecked))
  assert.equal(v.safeParse(checkedInput, { id: 'u1' }).success, true)
  assert.equal(v.safeParse(checkedInput, { id: 'x1' }).success, false)

  const transformed = v.pipe(
    v.object({ id: v.string() }),
    v.transform((value) => ({ ...value, id: value.id.length }))
  )
  failureTag(local.encoded(transformed), 'SchemaUnsupportedOperation')
  failureTag(local.fields(objectChecked), 'SchemaUnsupportedOperation')
})

test('Valibot async schemas retain async boundaries', async () => {
  const schema = v.objectAsync({ id: v.string() })
  assert.equal(Result.isOk(local.read(schema)), true)

  const encoded = unwrap(local.encoded(schema))
  const parsed = await v.safeParseAsync(encoded, { id: 'u1' })
  assert.equal(parsed.success, true)
})

test('Valibot props capability normalizes construction input before construct', () => {
  const descriptor = {
    schema: v.object({ id: v.string() }),
    propsSchema: v.pipe(
      v.object({ id: v.string() }),
      v.transform((value) => ({ id: Number(value.id) }))
    ),
    construct: (props) => ({ id: props.id, label: `#${props.id}` })
  }

  assert.equal(unwrap(local.props(descriptor)), descriptor.propsSchema)
  assert.deepEqual(unwrap(local.make(descriptor, { id: '42' })), {
    id: 42,
    label: '#42'
  })
  failureTag(local.make(descriptor, { id: 42 }), 'SchemaExecutionFailure')
})

test('Valibot explicit encoders capture throws, rejections, and async results', async () => {
  const schema = v.string()
  const configured = Schema.with(ValibotAdapter.withEncoder((_schema, value) => String(value)))

  assert.equal(unwrap(configured.encode(schema, 42)), '42')

  const thrown = new Error('encoder threw')
  const throwing = Schema.with(
    ValibotAdapter.withEncoder(() => {
      throw thrown
    })
  )
  const thrownResult = throwing.encode(schema, 'value')
  failureTag(thrownResult, 'SchemaExecutionFailure')
  if (Result.isError(thrownResult)) assert.equal(thrownResult.error.cause, thrown)

  const rejected = new Error('encoder rejected')
  const rejecting = Schema.with(ValibotAdapter.withEncoder(() => Promise.reject(rejected)))
  const rejectedResult = rejecting.encode(schema, 'value')
  failureTag(rejectedResult, 'SchemaAsyncRequired')
  await Promise.resolve()

  const asyncEncoder = Schema.with(
    ValibotAdapter.withEncoder(
      (valueSchema, value) => String(value),
      async (_valueSchema, value) => `${value}!`
    )
  )
  assert.equal(unwrap(await asyncEncoder.encodeAsync(schema, 'value')), 'value!')
  assert.equal(typeof asyncEncoder.encode, 'function')
})

test('Valibot adapter captures provider property and constructor failures', async () => {
  const broken = {
    get '~standard'() {
      throw new Error('broken provider')
    }
  }
  const readResult = local.read(broken)
  failureTag(readResult, 'SchemaExecutionFailure')
  if (Result.isError(readResult)) assert.ok(readResult.error instanceof SchemaExecutionFailure)

  const asyncOnly = ValibotAdapter.configure({
    encodeAsync: async () => 'encoded'
  })
  const facade = Schema.with(asyncOnly)
  failureTag(facade.encode(v.string(), 'value'), 'SchemaUnsupportedOperation')
  assert.equal(typeof facade.encodeAsync, 'function')
  const asyncResult = await facade.encodeAsync(v.string(), 'value')
  assert.equal(Result.isOk(asyncResult), true)
  if (Result.isOk(asyncResult)) assert.equal(asyncResult.value, 'encoded')
})

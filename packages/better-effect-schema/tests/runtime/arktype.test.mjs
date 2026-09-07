import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Result } from 'better-result'
import { type } from 'arktype'

import {
  Schema,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from '../../dist/esm/index.js'
import { ArkTypeAdapter } from 'better-effect-schema/arktype'

const S = Schema.with(ArkTypeAdapter)

test('a callable ArkType Type is decoded through Standard Schema without the adapter', () => {
  const User = type({ id: 'string', name: 'string' })

  const decoded = Schema.decodeUnknown(User, { id: 'user-1', name: 'Ada' })

  assert.equal(Result.isOk(decoded), true)
  if (Result.isOk(decoded)) assert.deepEqual(decoded.value, { id: 'user-1', name: 'Ada' })
})

test('the local facade keeps the generic async Standard Schema path', async () => {
  const User = type({ id: 'string' })

  const decoded = await S.decodeUnknownAsync(User, { id: 'user-1' })

  assert.equal(Result.isOk(decoded), true)
  if (Result.isOk(decoded)) assert.deepEqual(decoded.value, { id: 'user-1' })
})

test('the local facade exposes native capabilities and no implicit encoder', () => {
  assert.equal(Object.isFrozen(ArkTypeAdapter), true)
  assert.equal(Object.isFrozen(S), true)
  assert.equal(typeof S.decodeUnknown, 'function')
  assert.equal(typeof S.fields, 'function')
  assert.equal(typeof S.derive, 'function')
  assert.equal('encode' in S, false)
  assert.equal('toJSONSchema' in S, false)
})

test('encoded uses ArkType in projection without executing the morph', () => {
  let morphCalls = 0
  const Numeric = type('string').pipe((value) => {
    morphCalls += 1
    return Number(value)
  }, type('number'))

  const encoded = S.encoded(Numeric)

  assert.equal(Result.isOk(encoded), true)
  if (Result.isOk(encoded)) {
    const raw = encoded.value('42')
    assert.equal(raw, '42')
    assert.equal(morphCalls, 0)
    assert.equal(Result.isError(Schema.decodeUnknown(Numeric, '42')), false)
    assert.equal(morphCalls, 1)
    assert.equal(encoded.value(42) instanceof type.errors, true)
  }
})

test('read and bridge preserve the original callable Type identity', () => {
  const User = type({ id: 'string' })

  const read = S.read(User)
  const bridge = S.bridge(User)

  assert.equal(Result.isOk(read), true)
  assert.equal(Result.isOk(bridge), true)
  if (Result.isOk(read)) assert.equal(read.value, User)
  if (Result.isOk(bridge)) assert.equal(bridge.value, User)
})

test('fields and props expose real ArkType object capabilities', () => {
  const User = type({ id: 'string', name: 'string', 'age?': 'number' })
  const fields = S.fields(User)

  assert.equal(Result.isOk(fields), true)
  if (Result.isOk(fields)) {
    assert.deepEqual(Object.keys(fields.value), ['id', 'name', 'age'])
    assert.equal(fields.value.id('user-1') instanceof type.errors, false)
    assert.equal(fields.value.id(1) instanceof type.errors, true)

    const structured = S.struct(User, fields.value)
    assert.equal(Result.isOk(structured), true)
    if (Result.isOk(structured)) {
      assert.equal(structured.value({ id: 'user-1', name: 'Ada' }) instanceof type.errors, false)
    }
  }

  const descriptor = {
    schema: User,
    propsSchema: User,
    construct: (props) => ({ ...props })
  }
  const props = S.props(descriptor)

  assert.equal(Result.isOk(props), true)
  if (Result.isOk(props)) assert.equal(props.value, User)
})

test('make validates props once and captures constructor failures', () => {
  let constructions = 0
  const User = type({ id: 'string' })
  const descriptor = {
    schema: User,
    propsSchema: User,
    construct: (props) => {
      constructions += 1
      return { ...props }
    }
  }

  const made = S.make(descriptor, { id: 'user-1' })
  const rejected = S.make(descriptor, { id: 1 })

  assert.equal(Result.isOk(made), true)
  assert.equal(Result.isError(rejected), true)
  assert.equal(constructions, 1)
  if (Result.isError(rejected)) assert.ok(rejected.error instanceof SchemaExecutionFailure)

  const broken = S.make(
    {
      ...descriptor,
      construct: () => {
        throw new Error('constructor')
      }
    },
    { id: 'user-1' }
  )
  assert.equal(Result.isError(broken), true)
  if (Result.isError(broken)) assert.ok(broken.error instanceof SchemaExecutionFailure)
})

test('object policies use ArkType behavior without mutating the source', () => {
  const User = type({ id: 'string' })

  const strict = S.policy(User, 'strict')
  const loose = S.policy(User, 'loose')
  const strip = S.policy(User, 'strip')
  const catchall = S.policy(User, 'catchall')

  assert.equal(Result.isOk(strict), true)
  assert.equal(Result.isOk(loose), true)
  assert.equal(Result.isOk(strip), true)
  assert.equal(Result.isError(catchall), true)
  if (Result.isOk(strict))
    assert.equal(strict.value({ id: '1', extra: true }) instanceof type.errors, true)
  if (Result.isOk(loose))
    assert.equal(loose.value({ id: '1', extra: true }) instanceof type.errors, false)
  if (Result.isOk(strip)) {
    const result = strip.value({ id: '1', extra: true })
    assert.equal(result instanceof type.errors, false)
    assert.deepEqual(result, { id: '1' })
  }
  assert.equal(User({ id: '1', extra: true }) instanceof type.errors, false)
  if (Result.isError(catchall)) assert.ok(catchall.error instanceof SchemaUnsupportedOperation)
})

test('native derivations preserve object semantics and reject unavailable variants', () => {
  const User = type({ id: 'string', name: 'string', 'age?': 'number' })

  const picked = S.derive(User, 'pick', ['id'])
  const omitted = S.derive(User, 'omit', { age: true })
  const partial = S.derive(User, 'partial')
  const required = S.derive(User, 'required')
  const extended = S.derive(User, 'extend', { active: 'boolean' })
  const exactPartial = S.derive(User, 'exactPartial')
  const deepPartial = S.derive(User, 'deepPartial')

  for (const result of [picked, omitted, partial, required, extended]) {
    assert.equal(Result.isOk(result), true)
  }
  assert.equal(Result.isError(exactPartial), true)
  assert.equal(Result.isError(deepPartial), true)
  if (Result.isError(exactPartial))
    assert.ok(exactPartial.error instanceof SchemaUnsupportedOperation)
  if (Result.isError(deepPartial))
    assert.ok(deepPartial.error instanceof SchemaUnsupportedOperation)
  if (Result.isOk(picked)) assert.equal(picked.value({ id: '1' }) instanceof type.errors, false)
  if (Result.isOk(extended))
    assert.equal(
      extended.value({ id: '1', name: 'Ada', active: true }) instanceof type.errors,
      false
    )
})

test('non-object native boundaries fail with typed unsupported results', () => {
  const Union = type({ id: 'string' }).or({ name: 'string' })
  const ArrayType = type('string').array()

  const unionFields = S.fields(Union)
  const arrayFields = S.fields(ArrayType)
  const unionDerivation = S.derive(Union, 'pick', ['id'])

  for (const result of [unionFields, arrayFields, unionDerivation]) {
    assert.equal(Result.isError(result), true)
    if (Result.isError(result)) assert.ok(result.error instanceof SchemaUnsupportedOperation)
  }
})

test('unsafe structural derivations fail instead of dropping root refinements', () => {
  const Refined = type({ id: 'string', name: 'string' }).narrow((value) => value.id !== 'blocked')

  const derived = S.derive(Refined, 'pick', ['id'])
  const structured = S.struct(Refined, { id: type('string') })

  assert.equal(Result.isError(derived), true)
  assert.equal(Result.isError(structured), true)
  if (Result.isError(derived)) assert.ok(derived.error instanceof SchemaUnsupportedOperation)
  if (Result.isError(structured)) assert.ok(structured.error instanceof SchemaUnsupportedOperation)
})

test('invalid native definitions and hostile getters become typed failures', () => {
  const User = type({ id: 'string' })
  const invalid = S.derive(User, 'extend', { id: 'not a valid ArkType definition ???' })
  assert.equal(Result.isError(invalid), true)
  if (Result.isError(invalid)) assert.ok(invalid.error instanceof SchemaDefinitionFailure)

  const hostile = Object.create(User)
  Object.defineProperty(hostile, 'props', {
    configurable: true,
    get() {
      throw new Error('hostile props')
    }
  })
  const fields = S.fields(hostile)
  assert.equal(Result.isError(fields), true)
  if (Result.isError(fields)) assert.ok(fields.error instanceof SchemaExecutionFailure)

  const malformed = S.read({
    '~standard': { vendor: 'arktype', version: 1, validate: () => ({ value: 1 }) }
  })
  assert.equal(Result.isError(malformed), true)
  if (Result.isError(malformed)) assert.ok(malformed.error instanceof SchemaDefinitionFailure)
})

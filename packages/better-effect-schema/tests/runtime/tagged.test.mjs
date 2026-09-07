import assert from 'node:assert/strict'
import test from 'node:test'
import * as z from 'zod'
import { Result, TaggedError as BetterResultTaggedError } from 'better-result'

import { Schema, Z, ZodClassError } from '../../dist/esm/index.js'

class UserCreated extends Z.TaggedClass()('UserCreated', {
  userId: z.uuid()
}) {
  get summary() {
    return `created:${this.userId}`
  }
}

class UserDeleted extends Z.TaggedClass()('UserDeleted', {
  userId: z.uuid()
}) {}

test('TaggedClass injects its tag during construction', () => {
  const event = new UserCreated({
    userId: '550e8400-e29b-41d4-a716-446655440000'
  })

  assert.equal(event._tag, 'UserCreated')
  assert.equal(event.summary, 'created:550e8400-e29b-41d4-a716-446655440000')
  assert.deepEqual(UserCreated.encode(event), {
    _tag: 'UserCreated',
    userId: '550e8400-e29b-41d4-a716-446655440000'
  })
})

test('TaggedClass decodes discriminated values and rejects a wrong tag', () => {
  const event = UserCreated.parse({
    _tag: 'UserCreated',
    userId: '550e8400-e29b-41d4-a716-446655440000'
  })

  assert.ok(event instanceof UserCreated)
  assert.throws(
    () =>
      UserCreated.parse({
        _tag: 'UserDeleted',
        userId: '550e8400-e29b-41d4-a716-446655440000'
      }),
    z.ZodError
  )
  assert.throws(
    () =>
      new UserCreated({
        _tag: 'UserDeleted',
        userId: '550e8400-e29b-41d4-a716-446655440000'
      }),
    (error) => error instanceof ZodClassError && error.code === 'INVALID_TAG'
  )
})

test('tagged classes compose in unions', () => {
  const Event = z.union([UserCreated, UserDeleted])
  const deleted = Event.parse({
    _tag: 'UserDeleted',
    userId: '550e8400-e29b-41d4-a716-446655440000'
  })

  assert.ok(deleted instanceof UserDeleted)
})

test('tagged derivations preserve and protect the tag', () => {
  class UserCreatedSummary extends UserCreated.pick('UserCreatedSummary')({
    userId: true
  }) {}
  class OptionalUserCreated extends UserCreated.partial('OptionalUserCreated') {}

  const summary = UserCreatedSummary.parse({
    _tag: 'UserCreated',
    userId: '550e8400-e29b-41d4-a716-446655440000'
  })
  const optional = new OptionalUserCreated()

  assert.equal(summary._tag, 'UserCreated')
  assert.deepEqual(UserCreatedSummary.encode(summary), {
    _tag: 'UserCreated',
    userId: '550e8400-e29b-41d4-a716-446655440000'
  })
  assert.deepEqual(OptionalUserCreated.encode(optional), {
    _tag: 'UserCreated'
  })
  assert.throws(
    () => UserCreated.omit('Broken')({ _tag: true }),
    (error) => error instanceof ZodClassError && error.code === 'INVALID_TAG'
  )
  assert.throws(
    () => UserCreated.extend('Broken')({ _tag: z.literal('Other') }),
    (error) => error instanceof ZodClassError && error.code === 'INVALID_TAG'
  )
})

class UserNotFound extends Z.TaggedError()('UserNotFound', {
  userId: z.uuid()
}) {
  get message() {
    return `User ${this.userId} was not found`
  }
}

test('TaggedError is a real Error and remains a bidirectional schema', () => {
  const error = new UserNotFound({
    userId: '550e8400-e29b-41d4-a716-446655440000'
  })

  assert.ok(error instanceof Error)
  assert.ok(error instanceof UserNotFound)
  assert.equal(error.name, 'UserNotFound')
  assert.equal(error._tag, 'UserNotFound')
  assert.equal(error.message, 'User 550e8400-e29b-41d4-a716-446655440000 was not found')
  assert.equal(typeof error.stack, 'string')

  const decoded = UserNotFound.parse({
    _tag: 'UserNotFound',
    userId: '550e8400-e29b-41d4-a716-446655440000'
  })

  assert.ok(decoded instanceof Error)
  assert.deepEqual(UserNotFound.encode(decoded), {
    _tag: 'UserNotFound',
    userId: '550e8400-e29b-41d4-a716-446655440000'
  })
})

test('required derivations keep the protected tag as a literal schema', () => {
  class OptionalUserCreated extends UserCreated.partial('OptionalBeforeRequired') {}
  class RequiredUserCreated extends OptionalUserCreated.required('RequiredAfterOptional') {}

  assert.ok(RequiredUserCreated.fields._tag instanceof z.ZodLiteral)
  assert.equal(RequiredUserCreated.fields._tag.value, 'UserCreated')
})

test('TaggedError reports reserved fields as a typed definition failure', () => {
  for (const reserved of ['name', 'stack', 'cause', 'match', 'toJSON']) {
    const Invalid = Z.TaggedError()(`Invalid${reserved}`, { [reserved]: z.string() })
    const result = Invalid.make({ [reserved]: 'forbidden' })

    assert.equal(Result.isError(result), true)
    if (Result.isError(result)) {
      assert.equal(result.error._tag, 'SchemaDefinitionFailure')
    }
  }
})

const standardString = {
  '~standard': {
    version: 1,
    vendor: 'tagged-test',
    types: { input: '', output: '' },
    validate(value) {
      return typeof value === 'string' ? { value } : { issues: [{ message: 'Expected a string' }] }
    }
  }
}

test('portable TaggedClass keeps real inheritance and safe construction', () => {
  class PortableUser extends Schema.TaggedClass()('PortableUser', {
    userId: standardString
  }) {
    #secret = 'private'

    get summary() {
      return `${this.userId}:${this.#secret}`
    }
  }

  const result = PortableUser.make({ userId: 'user-1' })
  assert.equal(Result.isOk(result), true)
  if (Result.isOk(result)) {
    assert.ok(result.value instanceof PortableUser)
    assert.equal(result.value._tag, 'PortableUser')
    assert.equal(result.value.summary, 'user-1:private')
    assert.deepEqual(PortableUser.encode(result.value), {
      _tag: 'PortableUser',
      userId: 'user-1'
    })
  }

  const topLevel = Schema.make(PortableUser, { userId: 'user-1' })
  assert.equal(Result.isOk(topLevel), true)

  const decoded = PortableUser.decode({
    _tag: 'PortableUser',
    userId: 'user-2'
  })
  assert.equal(Result.isOk(decoded), true)
  const decodedThroughSchema = Schema.decodeUnknown(PortableUser, {
    _tag: 'PortableUser',
    userId: 'user-3'
  })
  assert.equal(Result.isOk(decodedThroughSchema), true)
  if (Result.isOk(decodedThroughSchema)) {
    assert.ok(decodedThroughSchema.value instanceof PortableUser)
  }
  assert.equal(PortableUser.is({ _tag: 'PortableUser', userId: 'user-2' }), false)

  const wrongTag = PortableUser.make({ _tag: 'Other', userId: 'user-1' })
  assert.equal(Result.isError(wrongTag), true)

  class EmptyTagged extends Schema.TaggedClass()('EmptyTagged', {}) {}
  const empty = EmptyTagged.make()
  assert.equal(Result.isOk(empty), true)
})

test('portable TaggedError preserves better-result protocol and public encoding', () => {
  class PortableNotFound extends Schema.TaggedError()('PortableNotFound', {
    userId: standardString
  }) {
    get message() {
      return `User ${this.userId} was not found`
    }
  }

  const result = PortableNotFound.make({ userId: 'user-1' })
  assert.equal(Result.isOk(result), true)
  if (Result.isOk(result)) {
    const error = result.value
    assert.ok(error instanceof Error)
    assert.ok(error instanceof PortableNotFound)
    assert.equal(BetterResultTaggedError.is(error), true)
    assert.equal(typeof error.match, 'function')
    assert.equal(typeof error[Symbol.iterator], 'function')
    assert.equal(error.message, 'User user-1 was not found')
    assert.deepEqual(PortableNotFound.encode(error), {
      _tag: 'PortableNotFound',
      userId: 'user-1'
    })

    const propagated = Result.gen(function* () {
      yield* error
      return Result.ok('unreachable')
    })
    assert.equal(Result.isError(propagated), true)
    if (Result.isError(propagated)) assert.strictEqual(propagated.error, error)
  }
})

test('portable tagged async boundaries capture rejections and constructor throws', async () => {
  let validations = 0
  const asyncString = {
    '~standard': {
      version: 1,
      vendor: 'tagged-test',
      validate(value) {
        validations += 1
        return Promise.resolve(
          typeof value === 'string' ? { value } : { issues: [{ message: 'Expected a string' }] }
        )
      }
    }
  }

  class AsyncUser extends Schema.TaggedClass()('AsyncUser', { userId: asyncString }) {}

  const sync = AsyncUser.make({ userId: 'user-1' })
  assert.equal(Result.isError(sync), true)
  if (Result.isError(sync)) assert.equal(sync.error._tag, 'SchemaAsyncRequired')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(validations, 1)

  const asyncResult = await AsyncUser.makeAsync({ userId: 'user-1' })
  assert.equal(Result.isOk(asyncResult), true)
  assert.equal(validations, 2)

  const decodedAsync = await Schema.decodeUnknownAsync(AsyncUser, {
    _tag: 'AsyncUser',
    userId: 'user-1'
  })
  assert.equal(Result.isOk(decodedAsync), true)
  assert.equal(validations, 3)

  const rejected = {
    '~standard': {
      version: 1,
      vendor: 'tagged-test',
      validate() {
        return Promise.reject(new Error('validator exploded'))
      }
    }
  }
  class RejectedUser extends Schema.TaggedClass()('RejectedUser', { userId: rejected }) {}
  const rejectedResult = await RejectedUser.makeAsync({ userId: 'user-1' })
  assert.equal(Result.isError(rejectedResult), true)
  if (Result.isError(rejectedResult))
    assert.equal(rejectedResult.error._tag, 'SchemaExecutionFailure')

  class ThrowingUser extends Schema.TaggedClass()('ThrowingUser', { userId: standardString }) {
    constructor(props) {
      super(props)
      throw new Error('constructor exploded')
    }
  }
  const thrown = ThrowingUser.make({ userId: 'user-1' })
  assert.equal(Result.isError(thrown), true)
  if (Result.isError(thrown)) assert.equal(thrown.error._tag, 'SchemaExecutionFailure')
})

test('Schema is the preferred facade while Z remains an alias', () => {
  assert.strictEqual(Schema.Class, Z.Class)
  assert.strictEqual(Schema.TaggedError, Z.TaggedError)
})

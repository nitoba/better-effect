import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result, TaggedError } from 'better-result'
import { Schema } from 'better-effect-schema'

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}

const stringSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'better-effect-schema-example',
    validate(value) {
      return typeof value === 'string' ? { value } : { issues: [{ message: 'Expected a string' }] }
    }
  }
}

class UserCreated extends Schema.TaggedClass<UserCreated>()('UserCreated', {
  userId: stringSchema
}) {}

class UserDeleted extends Schema.TaggedClass<UserDeleted>()('UserDeleted', {
  userId: stringSchema
}) {}

const userEventSchema: StandardSchemaV1<unknown, UserCreated | UserDeleted> = {
  '~standard': {
    version: 1,
    vendor: 'better-effect-schema-example',
    validate(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { issues: [{ message: 'Expected a tagged event' }] }
      }

      const tag = (value as Record<string, unknown>)['_tag']
      if (tag === 'UserCreated') {
        const decoded = Schema.decodeUnknown(UserCreated, value)
        return Result.isError(decoded)
          ? { issues: [{ message: decoded.error.message }] }
          : { value: decoded.value }
      }

      if (tag === 'UserDeleted') {
        const decoded = Schema.decodeUnknown(UserDeleted, value)
        return Result.isError(decoded)
          ? { issues: [{ message: decoded.error.message }] }
          : { value: decoded.value }
      }

      return { issues: [{ message: 'Unknown event tag' }] }
    }
  }
}

const eventResult = Schema.decodeUnknown(userEventSchema, {
  _tag: 'UserCreated',
  userId: 'user-1'
})
if (Result.isError(eventResult)) throw eventResult.error
const event = eventResult.value

assert(event instanceof UserCreated, 'union must preserve concrete class')
assert(event._tag === 'UserCreated', 'tag must be decoded')

class UserNotFound extends Schema.TaggedError<UserNotFound>()('UserNotFound', {
  userId: stringSchema
}) {
  override get message(): string {
    return `User ${this.userId} was not found`
  }
}

const failureResult = UserNotFound.make({ userId: 'user-1' })
if (Result.isError(failureResult)) throw failureResult.error
const failure = failureResult.value

assert(failure instanceof Error, 'TaggedError must be an Error')
assert(failure._tag === 'UserNotFound', 'TaggedError must inject its tag')
assert(failure.message.includes(failure.userId), 'custom message must work')
assert(TaggedError.is(failure), 'must use the better-result error protocol')
assert(
  failure.match({ UserNotFound: (error) => error.userId }) === failure.userId,
  'instance matching must work'
)

const shortCircuited = Result.gen(function* () {
  yield* failure
  return Result.ok('unreachable')
})
assert(Result.isError(shortCircuited), 'yielding the error must short-circuit')

console.log('tagged-errors: ok')

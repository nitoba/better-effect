import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result, type AnyTaggedError } from 'better-result'

import { Schema, type Encoded, type Props } from '../src/index.js'
import type { Equal, Expect } from './helpers.js'

const stringSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'tagged-type-test',
    validate(value) {
      return typeof value === 'string' ? { value } : { issues: [{ message: 'Expected a string' }] }
    }
  }
}

class UserCreated extends Schema.TaggedClass<UserCreated>()('UserCreated', {
  userId: stringSchema
}) {
  get summary(): string {
    return `created:${this.userId}`
  }
}

new UserCreated({ userId: 'user-1' })
// @ts-expect-error the tag is injected by the constructor
new UserCreated({ _tag: 'UserCreated', userId: 'user-1' })

const event = Schema.decodeUnknown(UserCreated, { _tag: 'UserCreated', userId: 'user-1' })
if (event.status === 'ok') {
  event.value.summary satisfies string
  event.value._tag satisfies 'UserCreated'
}

type _Props = Expect<Equal<Props<typeof UserCreated>, { readonly userId: string }>>
const encodedEvent: Encoded<typeof UserCreated> = {
  _tag: 'UserCreated',
  userId: 'user-1'
}
encodedEvent._tag satisfies 'UserCreated'
encodedEvent.userId satisfies string

class UserNotFound extends Schema.TaggedError<UserNotFound>()('UserNotFound', {
  userId: stringSchema
}) {
  override get message(): string {
    return `User ${this.userId} was not found`
  }
}

const error = new UserNotFound({ userId: 'user-1' })
error.stack satisfies string | undefined
error.message satisfies string
error._tag satisfies 'UserNotFound'
error satisfies AnyTaggedError
error.match({ UserNotFound: (failure) => failure.userId }) satisfies string
error[Symbol.iterator]()

const constructed = UserNotFound.make({ userId: 'user-1' })
if (constructed.status === 'ok') constructed.value satisfies UserNotFound

const decoded = Schema.decodeUnknown(UserNotFound, { _tag: 'UserNotFound', userId: 'user-1' })
if (decoded.status === 'ok') decoded.value satisfies UserNotFound

Result.gen(function* () {
  const failure = yield* UserNotFound.make({ userId: 'user-1' })
  return Result.err(failure)
})

Schema.TaggedError<UserNotFound>()('ValidError', { reason: stringSchema })
Schema.TaggedError<UserNotFound>()('InvalidErrorName', {
  // @ts-expect-error Error.name is reserved
  name: stringSchema
})

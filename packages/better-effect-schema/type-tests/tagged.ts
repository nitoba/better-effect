import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'
import type { AnyTaggedError } from 'better-result'

import { Schema, Z } from '../src/index.js'
import type { Equal, Expect } from './helpers.js'

const stringSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'tagged-type-test',
    types: { input: '', output: '' },
    validate(value) {
      return typeof value === 'string' ? { value } : { issues: [{ message: 'Expected a string' }] }
    }
  }
}

class UserCreated extends Z.TaggedClass<UserCreated>()('UserCreated', {
  userId: stringSchema
}) {
  get summary(): string {
    return `created:${this.userId}`
  }
}

new UserCreated({ userId: '550e8400-e29b-41d4-a716-446655440000' })
new UserCreated({
  // @ts-expect-error the tag is injected and cannot be supplied to the constructor
  _tag: 'UserCreated',
  userId: '550e8400-e29b-41d4-a716-446655440000'
})

const event = UserCreated.parse({
  _tag: 'UserCreated',
  userId: '550e8400-e29b-41d4-a716-446655440000'
})
event.summary satisfies string
event._tag satisfies 'UserCreated'

type _Props = Expect<Equal<Z.Props<typeof UserCreated>, { readonly userId: string }>>
type _Encoded = Expect<
  Equal<Z.Encoded<typeof UserCreated>, { readonly _tag: 'UserCreated'; readonly userId: string }>
>

class UserNotFound extends Z.TaggedError<UserNotFound>()('UserNotFound', {
  userId: stringSchema
}) {
  override get message(): string {
    return `User ${this.userId} was not found`
  }
}

const error = new UserNotFound({
  userId: '550e8400-e29b-41d4-a716-446655440000'
})
error.stack satisfies string | undefined
error.message satisfies string
error._tag satisfies 'UserNotFound'
error satisfies AnyTaggedError
error.match({ UserNotFound: (failure) => failure.userId }) satisfies string
error[Symbol.iterator]()

const constructed = UserNotFound.make({ userId: 'user-1' })
if (constructed.status === 'ok') {
  constructed.value satisfies UserNotFound
}

const decoded = Schema.decodeUnknown(UserNotFound, {
  _tag: 'UserNotFound',
  userId: 'user-1'
})
if (decoded.status === 'ok') {
  decoded.value satisfies UserNotFound
}

const failNotFound = () =>
  Result.gen(function* () {
    const error = yield* UserNotFound.make({ userId: 'user-1' })
    return Result.err(error)
  })
failNotFound()

class UserCreatedSummary extends UserCreated.pick<UserCreatedSummary>('UserCreatedSummary')({
  userId: true
}) {}

new UserCreatedSummary({
  userId: '550e8400-e29b-41d4-a716-446655440000'
})
// @ts-expect-error protected tag is not a legal pick-mask key
UserCreated.pick<UserCreatedSummary>('Broken')({ _tag: true })
// @ts-expect-error protected tag cannot be overwritten by extension
UserCreated.extend<UserCreatedSummary>('Broken')({ _tag: stringSchema })

Z.TaggedError<UserNotFound>()('ValidError', { reason: stringSchema })
Z.TaggedError<UserNotFound>()('InvalidErrorName', {
  // @ts-expect-error Error.name is reserved by TaggedError
  name: stringSchema
})
Z.TaggedError<UserNotFound>()('InvalidErrorStack', {
  // @ts-expect-error Error.stack is reserved by TaggedError
  stack: stringSchema
})

Z.TaggedError<UserNotFound>()('InvalidErrorMatch', {
  // @ts-expect-error match is reserved by better-result TaggedError
  match: stringSchema
})
Z.TaggedError<UserNotFound>()('InvalidErrorToJSON', {
  // @ts-expect-error toJSON is reserved by better-result TaggedError
  toJSON: stringSchema
})

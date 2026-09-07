import { describe, expect, test } from 'bun:test'
import * as z from 'zod'
import { isTaggedError, Result, TaggedError as ResultTaggedError } from 'better-result'

import {
  Schema,
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  TaggedClass,
  TaggedError
} from '../../dist/esm/index.js'
import {
  expectFailure,
  noThrowAsync,
  noThrowSync,
  standardIssue,
  standardSchema,
  unwrapOk
} from './helpers.js'

const encodedUser = standardSchema<
  { readonly id: string; readonly name: string },
  { readonly id: number; readonly name: string }
>((value) => {
  if (typeof value !== 'object' || value === null) {
    return { issues: [standardIssue('Expected an object')] }
  }
  const id = Reflect.get(value, 'id')
  const name = Reflect.get(value, 'name')
  if (typeof id !== 'string' || typeof name !== 'string') {
    return { issues: [standardIssue('Invalid user')] }
  }
  return { value: { id: Number(id), name } }
})

const userProps = standardSchema<
  { readonly id: number; readonly name: string },
  { readonly id: number; readonly name: string }
>((value) => {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof Reflect.get(value, 'id') !== 'number' ||
    typeof Reflect.get(value, 'name') !== 'string'
  ) {
    return { issues: [standardIssue('Invalid decoded props')] }
  }
  return { value: value as { readonly id: number; readonly name: string } }
})

const userEncoded = standardSchema<
  { readonly id: string; readonly name: string },
  { readonly id: string; readonly name: string }
>((value) => {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof Reflect.get(value, 'id') !== 'string' ||
    typeof Reflect.get(value, 'name') !== 'string'
  ) {
    return { issues: [standardIssue('Invalid encoded user')] }
  }
  return { value: value as { readonly id: string; readonly name: string } }
})

const portableText = standardSchema<string, string>((value) =>
  typeof value === 'string' ? { value } : { issues: [standardIssue('Expected text')] }
)

let domainConstructionCalls = 0

class DomainUser extends Schema.Class<DomainUser>('DomainUser', {
  title: 'Conformance user'
})({
  schema: encodedUser,
  propsSchema: userProps,
  encodedSchema: userEncoded,
  fields: { id: userProps, name: userProps }
}) {
  #secret = 'private-domain-state'

  get label(): string {
    return `${this.name}#${this.id}`
  }

  greet(): string {
    return `${this.label}:${this.#secret}`
  }

  constructor(props: { readonly id: number; readonly name: string }) {
    super(props)
    domainConstructionCalls += 1
  }
}

const constructorCause = new Error('constructor secret')

class ThrowingUser extends DomainUser {
  constructor(props: { readonly id: number; readonly name: string }) {
    super(props)
    throw constructorCause
  }
}

class AdminUser extends DomainUser {
  get role(): string {
    return 'admin'
  }
}

const tagField = z.string().min(1)

class UserCreated extends TaggedClass<UserCreated>()('UserCreated', {
  id: z.number().int(),
  name: tagField
}) {
  greet(): string {
    return `${this.name}#${this.id}`
  }
}

class UserNotFound extends TaggedError<UserNotFound>()('UserNotFound', {
  resource: z.string()
}) {
  get message(): string {
    return `Missing ${this.resource}`
  }
}

class PortableEvent extends TaggedClass<PortableEvent>()('PortableEvent', {
  eventId: portableText
}) {
  #secret = 'portable-private'

  get summary(): string {
    return `${this._tag}:${this.eventId}:${this.#secret}`
  }
}

class PortableFailure extends TaggedError<PortableFailure>()('PortableFailure', {
  eventId: portableText
}) {
  get message(): string {
    return `Missing ${this.eventId}`
  }
}

describe('classes and Standard Schema bridge', () => {
  test('constructs provider-neutral classes exactly once and preserves real identity', async () => {
    const originalConstruct = DomainUser
    const constructionsBefore = domainConstructionCalls
    const made = noThrowSync(() => DomainUser.make({ id: 7, name: 'Ada' }))
    const instance = unwrapOk(made)
    expect(domainConstructionCalls).toBe(constructionsBefore + 1)
    expect(instance).toBeInstanceOf(originalConstruct)
    expect(originalConstruct).not.toBeInstanceOf(z.ZodType)
    expect(instance.label).toBe('Ada#7')
    expect(instance.greet()).toContain('private-domain-state')
    expect(DomainUser.is(instance)).toBe(true)

    const decoded = noThrowSync(() => Schema.decodeUnknown(DomainUser, { id: '8', name: 'Grace' }))
    const decodedUser = unwrapOk(decoded)
    expect(domainConstructionCalls).toBe(constructionsBefore + 2)
    expect(decodedUser).toBeInstanceOf(DomainUser)
    expect(decodedUser.label).toBe('Grace#8')
    expect(DomainUser.is(decodedUser)).toBe(true)

    const asyncDecoded = await noThrowAsync(() =>
      Schema.decodeUnknownAsync(DomainUser, { id: '9', name: 'Katherine' })
    )
    const asyncUser = unwrapOk(asyncDecoded)
    expect(domainConstructionCalls).toBe(constructionsBefore + 3)
    expect(asyncUser).toBeInstanceOf(DomainUser)
    expect(asyncUser.label).toBe('Katherine#9')

    const unsafe = noThrowSync(() => DomainUser.unsafeMake({ id: 'unchecked', name: 'Unsafe' }))
    expect(domainConstructionCalls).toBe(constructionsBefore + 4)
    expect(unwrapOk(unsafe)).toBeInstanceOf(DomainUser)

    const topLevel = noThrowSync(() => Schema.make(DomainUser, { id: 10, name: 'Top' }))
    expect(domainConstructionCalls).toBe(constructionsBefore + 5)
    expect(unwrapOk(topLevel)).toBeInstanceOf(DomainUser)

    const topLevelAsync = await noThrowAsync(() =>
      Schema.makeAsync(DomainUser, { id: 11, name: 'Top async' })
    )
    expect(domainConstructionCalls).toBe(constructionsBefore + 6)
    expect(unwrapOk(topLevelAsync)).toBeInstanceOf(DomainUser)
  })

  test('exposes a protocol result with a concrete class instance, never Result', async () => {
    const standard = Reflect.get(DomainUser, '~standard') as {
      readonly validate: (value: unknown) => unknown
    }
    const result = await noThrowAsync(() => standard.validate({ id: '10', name: 'Margaret' }))

    expect(Result.isOk(result as never)).toBe(false)
    expect(typeof result).toBe('object')
    expect(Reflect.get(result as object, 'issues')).toBeUndefined()
    const value = Reflect.get(result as object, 'value')
    expect(value).toBeInstanceOf(DomainUser)
    expect((value as DomainUser).label).toBe('Margaret#10')
  })

  test('supports async construction and keeps construction failures typed', async () => {
    const asyncMade = await noThrowAsync(() => DomainUser.makeAsync({ id: 11, name: 'Dorothy' }))
    const instance = unwrapOk(asyncMade)
    expect(instance).toBeInstanceOf(DomainUser)

    const invalid = noThrowSync(() => DomainUser.make({ id: 'not-a-number', name: 'bad' }))
    expectFailure(invalid, SchemaConstructionFailure)

    const malformedClass = noThrowSync(() =>
      Schema.Class('InvalidConformanceClass')({
        schema: standardSchema(() => ({ value: {} })),
        propsSchema: standardSchema(() => ({ issues: [standardIssue('invalid props')] }))
      })
    )
    const malformedResult = noThrowSync(() =>
      (malformedClass as { make: (value: unknown) => unknown }).make(undefined)
    )
    expectFailure(malformedResult as never, SchemaConstructionFailure)
  })

  test('keeps callback failures in Result and does not leak secrets', () => {
    const throwingSchema = standardSchema(() => {
      throw new Error('schema-secret')
    })
    const result = noThrowSync(() => Schema.decodeUnknown(throwingSchema, 'input'))
    const error = expectFailure(result, SchemaExecutionFailure)
    expect(JSON.stringify(error)).not.toContain('schema-secret')
  })

  test('normalizes constructor defects as construction failures', () => {
    const result = noThrowSync(() => ThrowingUser.make({ id: 1, name: 'Ada' }))
    const failure = expectFailure(result, SchemaConstructionFailure)
    expect(failure.cause).toBe(constructorCause)
    expect(JSON.stringify(failure)).not.toContain('constructor secret')
  })

  test('preserves inherited generic class identity and members', () => {
    const result = noThrowSync(() => AdminUser.make({ id: 12, name: 'Ada' }))
    const admin = unwrapOk(result)
    expect(admin).toBeInstanceOf(AdminUser)
    expect(admin).toBeInstanceOf(DomainUser)
    expect(admin.role).toBe('admin')
    expect(AdminUser.is(admin)).toBe(true)
    expect(DomainUser.is(admin)).toBe(true)
  })
})

describe('TaggedClass and TaggedError conformance', () => {
  test('injects protected tags, preserves methods, and validates through the bridge', async () => {
    const parsed = unwrapOk(
      noThrowSync(() =>
        Schema.decodeUnknown(UserCreated, { _tag: 'UserCreated', id: 1, name: 'Ada' })
      )
    )
    expect(parsed).toBeInstanceOf(UserCreated)
    expect(parsed._tag).toBe('UserCreated')
    expect(parsed.greet()).toBe('Ada#1')
    expect(UserCreated.is(parsed)).toBe(true)

    const standard = Reflect.get(UserCreated, '~standard') as {
      readonly validate: (value: unknown) => unknown
    }
    const protocolResult = await noThrowAsync(() =>
      standard.validate({ _tag: 'UserCreated', id: 2, name: 'Grace' })
    )
    expect(Reflect.get(protocolResult as object, 'issues')).toBeUndefined()
    expect(Reflect.get(protocolResult as object, 'value')).toBeInstanceOf(UserCreated)

    const invalidTag = noThrowSync(() =>
      Schema.decodeUnknown(UserCreated, { _tag: 'Other', id: 3, name: 'bad' })
    )
    expectFailure(invalidTag, SchemaDecodeFailure)
  })

  test('is a better-result TaggedError while Standard Schema sees a value', async () => {
    const error = unwrapOk(
      noThrowSync(() =>
        Schema.decodeUnknown(UserNotFound, { _tag: 'UserNotFound', resource: 'user' })
      )
    )
    expect(error).toBeInstanceOf(UserNotFound)
    expect(ResultTaggedError.is(error)).toBe(true)
    expect(isTaggedError(error)).toBe(true)
    expect(error.message).toBe('Missing user')

    const standard = Reflect.get(UserNotFound, '~standard') as {
      readonly validate: (value: unknown) => unknown
    }
    const result = await noThrowAsync(() =>
      standard.validate({ _tag: 'UserNotFound', resource: 'account' })
    )
    const value = Reflect.get(result as object, 'value')
    expect(value).toBeInstanceOf(UserNotFound)
    expect(value).toBeInstanceOf(Error)
  })

  test('keeps Standard Schema tagged classes and errors provider-neutral', async () => {
    const event = unwrapOk(noThrowSync(() => PortableEvent.make({ eventId: 'evt-1' })))
    expect(event).toBeInstanceOf(PortableEvent)
    expect(event._tag).toBe('PortableEvent')
    expect(event.summary).toContain('portable-private')
    expect(PortableEvent.is(event)).toBe(true)

    const decoded = unwrapOk(
      noThrowSync(() =>
        Schema.decodeUnknown(PortableEvent, { _tag: 'PortableEvent', eventId: 'evt-2' })
      )
    )
    expect(decoded).toBeInstanceOf(PortableEvent)

    const standard = Reflect.get(PortableEvent, '~standard') as {
      readonly validate: (value: unknown) => unknown
    }
    const protocol = await noThrowAsync(() =>
      standard.validate({ _tag: 'PortableEvent', eventId: 'evt-3' })
    )
    expect(Reflect.get(protocol as object, 'value')).toBeInstanceOf(PortableEvent)

    const failure = unwrapOk(noThrowSync(() => PortableFailure.make({ eventId: 'evt-4' })))
    expect(failure).toBeInstanceOf(PortableFailure)
    expect(failure).toBeInstanceOf(Error)
    expect(ResultTaggedError.is(failure)).toBe(true)
    expect(failure.message).toBe('Missing evt-4')
    const propagated = Result.gen(function* () {
      yield* failure
      return Result.ok('unreachable')
    })
    expect(Result.isError(propagated)).toBe(true)
    if (Result.isError(propagated)) expect(propagated.error).toBe(failure)
  })

  test('does not throw for invalid declarations or reserved fields', () => {
    const invalidTag = noThrowSync(() => TaggedClass()('', { value: z.string() }))
    const invalidTagResult = noThrowSync(() =>
      (invalidTag as { make: (value: unknown) => unknown }).make({ value: 'x' })
    )
    expectFailure(invalidTagResult as never, SchemaDefinitionFailure)

    const reserved = noThrowSync(() => TaggedError()('Reserved', { name: z.string() } as never))
    const reservedResult = noThrowSync(() =>
      (reserved as { make: (value: unknown) => unknown }).make({ name: 'x' })
    )
    expectFailure(reservedResult as never, SchemaDefinitionFailure)
  })
})

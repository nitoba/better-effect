import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'

const uuidSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'better-effect-schema-example',
    validate(value) {
      return typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        ? { value }
        : { issues: [{ message: 'Expected a UUID' }] }
    }
  }
}

const isoDateSchema: StandardSchemaV1<string, Date> = {
  '~standard': {
    version: 1,
    vendor: 'better-effect-schema-example',
    validate(value) {
      if (typeof value !== 'string') return { issues: [{ message: 'Expected an ISO date' }] }
      const date = new Date(value)
      return Number.isNaN(date.getTime())
        ? { issues: [{ message: 'Expected an ISO date' }] }
        : { value: date }
    }
  }
}

class UserEvent extends Schema.TaggedClass<UserEvent>()('UserEvent', {
  userId: uuidSchema,
  occurredAt: isoDateSchema
}) {}

type UserEventEncoded = {
  readonly _tag: 'UserEvent'
  readonly userId: string
  readonly occurredAt: string
}

const isUserEventEncoded = (value: unknown): value is UserEventEncoded => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    candidate['_tag'] === 'UserEvent' &&
    typeof candidate['userId'] === 'string' &&
    typeof candidate['occurredAt'] === 'string'
  )
}

const encodedSchema: StandardSchemaV1<UserEventEncoded, UserEventEncoded> = {
  '~standard': {
    version: 1,
    vendor: 'better-effect-schema-example',
    validate(value) {
      return isUserEventEncoded(value)
        ? { value }
        : { issues: [{ message: 'Expected an encoded UserEvent' }] }
    }
  }
}

const userEventCodec: Schema.Codec<UserEventEncoded, UserEvent, UserEvent, UserEventEncoded> = {
  schema: { '~standard': UserEvent['~standard'] },
  encodedSchema,
  encode(value) {
    return Result.ok({
      _tag: 'UserEvent',
      userId: value.userId,
      occurredAt: value.occurredAt.toISOString()
    })
  }
}

// This is the same explicit pair used by a portable MQ codec adapter:
// unknown persisted JSON -> schema class, then class -> encoded JSON.
const decodePayload = Schema.decodeUnknown(UserEvent)
const encodePayload = Schema.encode(userEventCodec)

const decoded = decodePayload({
  _tag: 'UserEvent',
  userId: '550e8400-e29b-41d4-a716-446655440000',
  occurredAt: '2026-09-02T10:00:00.000Z'
})

if (Result.isError(decoded)) throw decoded.error
const encoded = encodePayload(decoded.value)
if (Result.isError(encoded)) throw encoded.error
if (typeof encoded.value.occurredAt !== 'string') {
  throw new Error('Expected JSON-oriented encoded payload')
}

console.log('mq-codec: ok')

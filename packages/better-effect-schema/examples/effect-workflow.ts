import * as z from 'zod'
import { Effect } from 'better-effect'
import { Result } from 'better-result'
import {
  Schema,
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaEncodeFailure,
  SchemaExecutionFailure
} from 'better-effect-schema'
import { ZodAdapter } from 'better-effect-schema/zod'

const local = Schema.with(ZodAdapter)

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class User extends local.Class<User>('examples/EffectUser')({
  id: z.uuid(),
  createdAt: DateFromISOString
}) {}

const input: unknown = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  createdAt: '2026-09-02T10:00:00.000Z'
}

const decoded = Schema.decodeUnknown(User)(input)
decoded satisfies Effect<
  User,
  | SchemaDecodeFailure
  | SchemaConstructionFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure
  | SchemaAsyncRequired,
  never
>

const roundTrip = Effect.gen(function* () {
  const user = yield* decoded
  const encoded = yield* Schema.encode(User)(user)
  return Result.ok(encoded)
})

roundTrip satisfies Effect<
  Schema.Encoded<typeof User>,
  | SchemaConstructionFailure
  | SchemaDecodeFailure
  | SchemaDefinitionFailure
  | SchemaEncodeFailure
  | import('better-effect-schema').SchemaUnsupportedOperation
  | SchemaExecutionFailure
  | SchemaAsyncRequired,
  never
>

if (roundTrip.status === 'error') throw roundTrip.error
if (typeof roundTrip.value.createdAt !== 'string') {
  throw new Error('Expected encoded date')
}

console.log('effect-workflow: ok')

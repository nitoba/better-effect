import * as z from 'zod'
import type { Effect } from 'better-effect'
import type { Result as ResultType } from 'better-result'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  type SchemaCapabilityFailure
} from '../src/index.js'
import { Schema } from '../src/zod.js'
import type { Equal, Expect } from './helpers.js'

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class User extends Schema.Class<User>('types/ZodFacadeUser')({
  id: z.uuid(),
  createdAt: DateFromISOString
}) {}

type _Input = Expect<Equal<Schema.Input<typeof DateFromISOString>, string>>
type _Output = Expect<Equal<Schema.Output<typeof DateFromISOString>, Date>>
type _Effect = Expect<Equal<Schema.Effect<string, never>, Effect<string, never, never>>>

const decoded = Schema.decode(User, {
  id: '550e8400-e29b-41d4-a716-446655440000',
  createdAt: '2026-09-09T00:00:00.000Z'
})
decoded satisfies Effect<
  User,
  | SchemaConstructionFailure
  | SchemaDecodeFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure
  | SchemaAsyncRequired,
  never
>

const encoded = Schema.encode(DateFromISOString, new Date())
encoded satisfies ResultType<string, SchemaCapabilityFailure>

const bridged = Schema.bridge(z.object({ id: z.string() }))
bridged satisfies ResultType<
  StandardSchemaV1<{ id: string }, { id: string }>,
  SchemaCapabilityFailure
>

type _UserInstance = Expect<Equal<InstanceType<typeof User>, User>>
const fields = Schema.fields(z.object({ id: z.string() }))
fields satisfies ResultType<Readonly<Record<string, StandardSchemaV1>>, SchemaCapabilityFailure>

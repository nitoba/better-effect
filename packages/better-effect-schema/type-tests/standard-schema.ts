import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Effect } from 'better-effect'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure
} from '../src/index.js'

type UserSchema = StandardSchemaV1<{ readonly id: string }, { readonly userId: string }>

declare const userSchema: UserSchema

const decoded = Schema.decode(userSchema)({ id: 'user-1' })
decoded satisfies Effect<
  { readonly userId: string },
  SchemaDecodeFailure | SchemaDefinitionFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>

const unknownDecoded = Schema.decodeUnknown(userSchema)({ id: 'user-1' })
unknownDecoded satisfies Effect<
  { readonly userId: string },
  SchemaDecodeFailure | SchemaDefinitionFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>

Schema.decode(userSchema, { id: 'user-1' }, { libraryOptions: { trace: true } })
Schema.decodeUnknown(userSchema, { id: 'user-1' }, { libraryOptions: { trace: true } })

// @ts-expect-error decode still checks the Standard Schema input type
Schema.decode(userSchema)({ id: 1 })

const asyncDecoded = Schema.decodeAsync(userSchema)({ id: 'user-1' })
asyncDecoded satisfies Promise<
  Effect<
    { readonly userId: string },
    SchemaDecodeFailure | SchemaDefinitionFailure | SchemaExecutionFailure | SchemaAsyncRequired,
    never
  >
>

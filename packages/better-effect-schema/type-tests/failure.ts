import type { Effect } from 'better-effect'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaEncodeFailure,
  SchemaExecutionFailure,
  type SchemaIssue
} from '../src/index.js'

const userSchema: StandardSchemaV1<{ readonly id: string }, { readonly id: string }> = {
  '~standard': {
    version: 1,
    vendor: 'type-test',
    validate: (value) => {
      const candidate = value as { readonly id?: unknown }
      return typeof value === 'object' && value !== null && typeof candidate.id === 'string'
        ? { value: { id: candidate.id } }
        : { issues: [{ message: 'invalid user' }] }
    }
  }
}

class User extends Schema.Class<User>('type/User')({
  schema: userSchema,
  propsSchema: userSchema,
  encodedSchema: userSchema,
  encode: (value) => value
}) {}

Schema.decodeUnknown(User)({ id: 'id' }) satisfies Effect<
  User,
  SchemaDecodeFailure |
    SchemaConstructionFailure |
    SchemaDefinitionFailure |
    SchemaExecutionFailure |
    SchemaAsyncRequired,
  never
>
Schema.encode(User)(new User({ id: 'id' })) satisfies Effect<
  { readonly id: string },
  SchemaEncodeFailure |
    SchemaDefinitionFailure |
    import('../src/index.js').SchemaUnsupportedOperation |
    SchemaExecutionFailure |
    SchemaAsyncRequired,
  never
>
Schema.make(User)({ id: 'id' }) satisfies Effect<
  User,
  SchemaConstructionFailure | SchemaDefinitionFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>

const issue: SchemaIssue = { message: 'Validation failed', path: ['user', 0] }
issue.message satisfies string

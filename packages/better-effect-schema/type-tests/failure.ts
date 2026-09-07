import * as z from 'zod'
import type { Effect } from 'better-effect'

import {
  Schema,
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaEncodeFailure,
  SchemaAsyncRequired,
  SchemaExecutionFailure,
  type SchemaIssue
} from '../src/index.js'

class User extends Schema.Class<User>('@type/User')({
  id: z.uuid(),
  name: z.string()
}) {}

Schema.decodeUnknown(User)({}) satisfies Effect<
  User,
  SchemaDecodeFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>
Schema.decode(User)({ id: 'id', name: 'Ada' }) satisfies Effect<
  User,
  SchemaDecodeFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>
Schema.encode(User)(new User({ id: 'id', name: 'Ada' })) satisfies Effect<
  { readonly id: string; readonly name: string },
  SchemaEncodeFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>
Schema.make(User)({ id: 'id', name: 'Ada' }) satisfies Effect<
  User,
  SchemaConstructionFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>

const issue: SchemaIssue = {
  message: 'Validation failed',
  path: ['user', 0]
}
issue.message satisfies string

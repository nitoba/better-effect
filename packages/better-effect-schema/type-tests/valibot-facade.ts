import * as v from 'valibot'
import type { Effect } from 'better-effect'
import type { Result as ResultType } from 'better-result'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import {
  SchemaAsyncRequired,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  type SchemaCapabilityFailure
} from '../src/index.js'
import { Schema } from '../src/valibot.js'
import type { Equal, Expect } from './helpers.js'

const User = v.object({ id: v.string(), name: v.optional(v.string(), 'Ada') })

type _Input = Expect<Equal<Schema.Input<typeof User>, v.InferInput<typeof User>>>
type _Output = Expect<Equal<Schema.Output<typeof User>, v.InferOutput<typeof User>>>
type _Effect = Expect<Equal<Schema.Effect<string, never>, Effect<string, never, never>>>

const decoded = Schema.decode(User, { id: 'valibot-user' })
decoded satisfies Effect<
  v.InferOutput<typeof User>,
  SchemaDecodeFailure | SchemaDefinitionFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>

const fields = Schema.fields(User)
fields satisfies ResultType<Readonly<Record<string, StandardSchemaV1>>, SchemaCapabilityFailure>

const derived = Schema.derive(User, 'partial')
derived satisfies ResultType<StandardSchemaV1, SchemaCapabilityFailure>

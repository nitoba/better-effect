import { type } from 'arktype'
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
import { Schema } from '../src/arktype.js'
import type { Equal, Expect } from './helpers.js'

const User = type({ id: 'string', name: 'string' })
const Numeric = type('string').pipe((value) => value.length, type('number'))

type _Input = Expect<Equal<Schema.Input<typeof User>, { id: string; name: string }>>
type _Output = Expect<Equal<Schema.Output<typeof User>, { id: string; name: string }>>
type _NumericInput = Expect<Equal<Schema.Input<typeof Numeric>, string>>
type _NumericOutput = Expect<Equal<Schema.Output<typeof Numeric>, number>>
type _Effect = Expect<Equal<Schema.Effect<string, never>, Effect<string, never, never>>>

const decoded = Schema.decode(Numeric, 'arktype-morph')
decoded satisfies Effect<
  number,
  SchemaDecodeFailure | SchemaDefinitionFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>

const fields = Schema.fields(User)
fields satisfies ResultType<Readonly<Record<string, StandardSchemaV1>>, SchemaCapabilityFailure>

const derived = Schema.derive(User, 'partial')
derived satisfies ResultType<StandardSchemaV1, SchemaCapabilityFailure>
